import test from "node:test";
import assert from "node:assert/strict";
import { decorateMath, extractMarkdownMath } from "../public/math-render.js";

class FakeNode {
  constructor(tagName = "#fragment") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.parentNode = null;
    this._text = "";
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? Object.assign(new FakeNode("#text"), { textContent: node }) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    node.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }

  replaceWith(node) {
    this.replacement = node;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  querySelector(selector) {
    return walk(this).find((node) => selector.startsWith(".") && node.className.split(" ").includes(selector.slice(1))) || null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-math-token]") return this.placeholders || [];
    return [];
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  get lastChild() {
    return this.children.at(-1) || null;
  }
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

function render(formula, display = true) {
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createDocumentFragment: () => new FakeNode()
  };
  const placeholder = new FakeNode("placeholder");
  placeholder.dataset.mathToken = "0";
  const root = new FakeNode("root");
  root.placeholders = [placeholder];
  decorateMath(root, [{ formula, raw: formula, display }], { copyButtons: false });
  return placeholder.replacement;
}

test("extracts math while preserving code spans and fenced code", () => {
  const result = extractMarkdownMath("`$code$` and $x_1$\n```tex\n$not_math$\n```\n$$y$$");
  assert.equal(result.formulas.length, 2);
  assert.deepEqual(result.formulas.map((item) => item.formula), ["x_1", "y"]);
  assert.match(result.markdown, /`\$code\$`/);
  assert.match(result.markdown, /\$not_math\$/);
});

test("renders bold vectors, roman subscripts, and relation commands", () => {
  const output = render(String.raw`\mathbf{X}_t \leftrightarrow \mathbf{u}_t`);
  const nodes = walk(output);
  assert.equal(nodes.filter((node) => node.className === "math-bold").length, 2);
  assert.equal(nodes.find((node) => node.tagName === "sub")?.textContent, "t");
  assert.equal(output.textContent.includes("\\mathbf"), false);
  assert.match(output.textContent, /↔/);
});

test("renders the camera transform matrix from the reported example", () => {
  const output = render(String.raw`T_{\mathrm{camera}\leftarrow\mathrm{base}} = \begin{bmatrix} R & t \\ 0 & 1 \end{bmatrix}`);
  const nodes = walk(output);
  assert.equal(nodes.filter((node) => node.className === "math-matrix-row").length, 2);
  assert.equal(nodes.filter((node) => node.className === "math-matrix-cell").length, 4);
  assert.equal(nodes.some((node) => node.className.includes("math-matrix-bmatrix")), true);
  assert.equal(output.textContent.includes("\\begin"), false);
  assert.equal(output.textContent.includes("\\mathrm"), false);
});

test("renders nested fractions, roots, and Greek symbols", () => {
  const output = render(String.raw`\frac{\alpha + 1}{\sqrt{x^2}}`);
  const nodes = walk(output);
  assert.equal(nodes.some((node) => node.className === "math-fraction"), true);
  assert.equal(nodes.some((node) => node.className === "math-root"), true);
  assert.match(output.textContent, /α/);
});

test("renders norm delimiters in all common LaTeX spellings", () => {
  const reported = render(String.raw`\|\mathbf{x}\|_2 = \sqrt{\sum_{i=1}^{n} x_i^2}`);
  const named = render(String.raw`\lVert x \rVert + \Vert y \Vert`);
  const sized = render(String.raw`\left\|z\right\|`);

  assert.equal(reported.textContent.includes("\\|"), false);
  assert.equal(walk(reported).filter((node) => node.className.includes("math-norm-delimiter")).length, 2);
  assert.equal((named.textContent.match(/‖/g) || []).length, 4);
  assert.equal(sized.textContent, "‖z‖");
});
