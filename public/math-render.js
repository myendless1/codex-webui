const commandSymbols = {
  longleftrightarrow: "⟷", leftrightarrow: "↔", longrightarrow: "⟶", rightarrow: "→", to: "→",
  Longrightarrow: "⟹", Rightarrow: "⇒", longleftarrow: "⟵", leftarrow: "←", Longleftarrow: "⟸", Leftarrow: "⇐", mapsto: "↦",
  times: "×", cdot: "·", pm: "±", mp: "∓", div: "÷", approx: "≈", sim: "∼", equiv: "≡", neq: "≠", ne: "≠",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", superset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", forall: "∀", exists: "∃", emptyset: "∅",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ϵ", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", ellipsis: "…"
};

const namedOperators = new Set(["sin", "cos", "tan", "arcsin", "arccos", "arctan", "log", "ln", "exp", "lim", "max", "min", "det"]);
const matrixEnvironments = new Set(["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "cases", "aligned"]);

function findClosing(source, start, closing) {
  let cursor = start;
  while (cursor < source.length) {
    const found = source.indexOf(closing, cursor);
    if (found < 0) return -1;
    let slashes = 0;
    for (let index = found - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
    if (slashes % 2 === 0) return found;
    cursor = found + closing.length;
  }
  return -1;
}

export function extractMarkdownMath(value) {
  const source = String(value || "");
  const formulas = [];
  let markdown = "";
  let cursor = 0;
  let fenceMarker = "";
  let inlineTicks = 0;

  while (cursor < source.length) {
    if (cursor === 0 || source[cursor - 1] === "\n") {
      const fence = source.slice(cursor).match(/^(?:`{3,}|~{3,})/)?.[0] || "";
      if (fence && (!fenceMarker || fence[0] === fenceMarker[0])) {
        fenceMarker = fenceMarker ? "" : fence;
        markdown += fence;
        cursor += fence.length;
        continue;
      }
    }
    if (!fenceMarker && source[cursor] === "`") {
      const ticks = source.slice(cursor).match(/^`+/)?.[0].length || 1;
      if (!inlineTicks || ticks === inlineTicks) inlineTicks = inlineTicks ? 0 : ticks;
      markdown += source.slice(cursor, cursor + ticks);
      cursor += ticks;
      continue;
    }
    if (fenceMarker || inlineTicks) {
      markdown += source[cursor++];
      continue;
    }

    let opening = "";
    let closing = "";
    let display = false;
    if (source.startsWith("$$", cursor)) {
      opening = closing = "$$";
      display = true;
    } else if (source.startsWith("\\[", cursor)) {
      opening = "\\[";
      closing = "\\]";
      display = true;
    } else if (source.startsWith("\\(", cursor)) {
      opening = "\\(";
      closing = "\\)";
    } else if ((cursor === 0 || source[cursor - 1] === "\n") && source[cursor] === "[" && source[cursor + 1] === "\n") {
      const bracketEnd = source.indexOf("\n]", cursor + 2);
      const body = bracketEnd < 0 ? "" : source.slice(cursor + 2, bracketEnd);
      if (bracketEnd >= 0 && /\\[A-Za-z]+/.test(body)) {
        opening = "[\n";
        closing = "\n]";
        display = true;
      }
    } else if (source[cursor] === "$" && source[cursor - 1] !== "\\" && !/\s/.test(source[cursor + 1] || "")) {
      opening = closing = "$";
    }
    if (!opening) {
      markdown += source[cursor++];
      continue;
    }
    const end = findClosing(source, cursor + opening.length, closing);
    if (end < 0 || (!display && closing === "$" && /\s/.test(source[end - 1] || ""))) {
      markdown += source[cursor++];
      continue;
    }
    const formula = source.slice(cursor + opening.length, end).trim();
    const raw = source.slice(cursor, end + closing.length);
    if (!formula) {
      markdown += raw;
      cursor = end + closing.length;
      continue;
    }
    const token = formulas.length;
    formulas.push({ formula, raw, display });
    markdown += display ? `\n<div data-math-token="${token}"></div>\n` : `<span data-math-token="${token}"></span>`;
    cursor = end + closing.length;
  }
  return { markdown, formulas };
}

function readGroup(source, start) {
  if (source[start] !== "{") return { value: source[start] || "", end: start + 1 };
  let depth = 1;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{" && source[cursor - 1] !== "\\") depth += 1;
    if (source[cursor] === "}" && source[cursor - 1] !== "\\") depth -= 1;
    if (depth === 0) return { value: source.slice(start + 1, cursor), end: cursor + 1 };
  }
  return { value: source.slice(start + 1), end: source.length };
}

function readArgument(source, start) {
  let cursor = start;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  if (source[cursor] === "{") return readGroup(source, cursor);
  if (source[cursor] === "\\") {
    const command = source.slice(cursor + 1).match(/^[A-Za-z]+/)?.[0] || source[cursor + 1] || "";
    return { value: source.slice(cursor, cursor + command.length + 1), end: cursor + command.length + 1 };
  }
  return { value: source[cursor] || "", end: Math.min(source.length, cursor + 1) };
}

function splitMatrix(source) {
  const rows = [[]];
  let value = "";
  let depth = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "{" && source[cursor - 1] !== "\\") depth += 1;
    if (character === "}" && source[cursor - 1] !== "\\") depth = Math.max(0, depth - 1);
    if (!depth && character === "&" && source[cursor - 1] !== "\\") {
      rows.at(-1).push(value.trim());
      value = "";
      continue;
    }
    if (!depth && character === "\\" && source[cursor + 1] === "\\") {
      rows.at(-1).push(value.trim());
      rows.push([]);
      value = "";
      cursor += 1;
      continue;
    }
    value += character;
  }
  rows.at(-1).push(value.trim());
  return rows.filter((row) => row.some(Boolean));
}

function appendFormulaElement(parent, className, source) {
  const element = document.createElement("span");
  element.className = className;
  element.append(formulaFragment(source));
  parent.append(element);
  return element;
}

function matrixFragment(environment, body) {
  const matrix = document.createElement("span");
  matrix.className = `math-matrix math-matrix-${environment}`;
  const table = document.createElement("span");
  table.className = "math-matrix-table";
  for (const row of splitMatrix(body)) {
    const rowElement = document.createElement("span");
    rowElement.className = "math-matrix-row";
    for (const cell of row) appendFormulaElement(rowElement, "math-matrix-cell", cell);
    table.append(rowElement);
  }
  matrix.append(table);
  return matrix;
}

function delimiterSymbol(command) {
  return ({
    "|": "‖", Vert: "‖", lVert: "‖", rVert: "‖",
    vert: "|", lvert: "|", rvert: "|", mid: "|",
    langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}"
  })[command] || commandSymbols[command] || `\\${command}`;
}

function formulaFragment(source) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  const appendText = (text, className = "") => {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = text;
    fragment.append(span);
  };

  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      while (/\s/.test(source[cursor + 1] || "")) cursor += 1;
      appendText(" ", "math-space");
      cursor += 1;
      continue;
    }
    if (source[cursor] === "\\") {
      const match = source.slice(cursor + 1).match(/^[A-Za-z]+/);
      const command = match?.[0] || source[cursor + 1] || "";
      cursor += 1 + command.length;

      if (["text", "textrm", "textnormal"].includes(command)) {
        const group = readArgument(source, cursor);
        appendText(group.value.replace(/\\([{}_])/g, "$1"), "math-roman");
        cursor = group.end;
        continue;
      }
      const style = ({ mathrm: "math-upright", operatorname: "math-operator", mathbf: "math-bold", bm: "math-bold", boldsymbol: "math-bold", mathit: "math-italic", mathsf: "math-sans", mathtt: "math-mono", mathcal: "math-cal" })[command];
      if (style) {
        const group = readArgument(source, cursor);
        appendFormulaElement(fragment, style, group.value);
        cursor = group.end;
        continue;
      }
      if (["frac", "dfrac", "tfrac"].includes(command)) {
        const numerator = readArgument(source, cursor);
        const denominator = readArgument(source, numerator.end);
        const fraction = document.createElement("span");
        fraction.className = "math-fraction";
        appendFormulaElement(fraction, "math-numerator", numerator.value);
        appendFormulaElement(fraction, "math-denominator", denominator.value);
        fragment.append(fraction);
        cursor = denominator.end;
        continue;
      }
      if (command === "sqrt") {
        let degree = "";
        if (source[cursor] === "[") {
          const end = source.indexOf("]", cursor + 1);
          if (end >= 0) {
            degree = source.slice(cursor + 1, end);
            cursor = end + 1;
          }
        }
        const radicand = readArgument(source, cursor);
        const root = document.createElement("span");
        root.className = "math-root";
        if (degree) appendFormulaElement(root, "math-root-degree", degree);
        const radical = document.createElement("span");
        radical.className = "math-radical";
        radical.textContent = "√";
        appendFormulaElement(root, "math-radicand", radicand.value);
        root.insertBefore(radical, root.querySelector(".math-radicand"));
        fragment.append(root);
        cursor = radicand.end;
        continue;
      }
      if (["overset", "underset"].includes(command)) {
        const annotation = readArgument(source, cursor);
        const base = readArgument(source, annotation.end);
        const stack = document.createElement("span");
        stack.className = command === "overset" ? "math-overset" : "math-underset";
        appendFormulaElement(stack, "math-over", annotation.value);
        appendFormulaElement(stack, "math-over-base", base.value);
        fragment.append(stack);
        cursor = base.end;
        continue;
      }
      if (["vec", "hat", "bar", "overline", "underline", "dot", "ddot"].includes(command)) {
        const group = readArgument(source, cursor);
        const accent = appendFormulaElement(fragment, `math-accent math-accent-${command}`, group.value);
        accent.dataset.accent = ({ vec: "⃗", hat: "^", bar: "¯", overline: "¯", underline: "_", dot: "˙", ddot: "¨" })[command];
        cursor = group.end;
        continue;
      }
      if (command === "begin" && source[cursor] === "{") {
        const name = readGroup(source, cursor);
        const ending = `\\end{${name.value}}`;
        const end = source.indexOf(ending, name.end);
        if (end >= 0 && matrixEnvironments.has(name.value)) {
          fragment.append(matrixFragment(name.value, source.slice(name.end, end)));
          cursor = end + ending.length;
          continue;
        }
      }
      if (["left", "right"].includes(command)) {
        if (source[cursor] === "\\") {
          const delimiter = source.slice(cursor + 1).match(/^[A-Za-z]+/)?.[0] || source[cursor + 1] || "";
          appendText(delimiterSymbol(delimiter), "math-delimiter");
          cursor += delimiter.length + 1;
        } else {
          if (source[cursor] !== ".") appendText(source[cursor] || "", "math-delimiter");
          cursor += 1;
        }
        continue;
      }
      if (["|", "Vert", "lVert", "rVert", "vert", "lvert", "rvert"].includes(command)) {
        appendText(delimiterSymbol(command), `math-delimiter ${["vert", "lvert", "rvert"].includes(command) ? "math-vert-delimiter" : "math-norm-delimiter"}`);
        continue;
      }
      if ([",", ";", ":", "!", "quad", "qquad"].includes(command)) {
        appendText(" ", command === "qquad" ? "math-space-wide" : "math-space");
        continue;
      }
      if (command === "\\") {
        appendText(" ", "math-space-wide");
        continue;
      }
      if (namedOperators.has(command)) {
        appendText(command, "math-operator");
        continue;
      }
      appendText(commandSymbols[command] || `\\${command}`, commandSymbols[command] ? "math-symbol" : "math-unknown");
      continue;
    }
    if ((source[cursor] === "_" || source[cursor] === "^") && fragment.lastChild) {
      const kind = source[cursor] === "_" ? "sub" : "sup";
      const group = readArgument(source, cursor + 1);
      const script = document.createElement(kind);
      script.append(formulaFragment(group.value));
      fragment.append(script);
      cursor = group.end;
      continue;
    }
    if (source[cursor] === "{") {
      const group = readGroup(source, cursor);
      fragment.append(formulaFragment(group.value));
      cursor = group.end;
      continue;
    }
    if (source[cursor] === "}") {
      cursor += 1;
      continue;
    }
    const plain = source.slice(cursor).match(/^[^\\{}_^\s]+/)?.[0] || source[cursor];
    appendText(plain, /[\u3400-\u9fff]/.test(plain) ? "math-roman" : "");
    cursor += plain.length;
  }
  return fragment;
}

export function decorateMath(root, formulas, { copyButtons = true } = {}) {
  root.querySelectorAll("[data-math-token]").forEach((placeholder) => {
    const item = formulas[Number(placeholder.dataset.mathToken)];
    if (!item) return;
    const wrapper = document.createElement(item.display ? "div" : "span");
    wrapper.className = item.display ? "math-block" : "math-inline";
    wrapper.setAttribute("role", "math");
    wrapper.setAttribute("aria-label", item.formula);
    const formula = document.createElement("span");
    formula.className = "math-formula";
    try {
      formula.append(formulaFragment(item.formula));
    } catch {
      formula.classList.add("math-render-fallback");
      formula.textContent = item.formula;
    }
    wrapper.append(formula);
    if (item.display && copyButtons) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "math-copy-button";
      copy.dataset.action = "copy-math";
      copy.dataset.mathSource = item.raw;
      copy.title = "复制 LaTeX 源码";
      copy.setAttribute("aria-label", "复制公式源码");
      copy.textContent = "复制源码";
      wrapper.append(copy);
    }
    placeholder.replaceWith(wrapper);
  });
}
