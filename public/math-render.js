const commandSymbols = {
  longleftrightarrow: "⟷",
  leftrightarrow: "↔",
  longrightarrow: "⟶",
  rightarrow: "→",
  Longrightarrow: "⟹",
  Rightarrow: "⇒",
  longleftarrow: "⟵",
  leftarrow: "←",
  Longleftarrow: "⟸",
  Leftarrow: "⇐",
  mapsto: "↦",
  times: "×",
  cdot: "·",
  pm: "±",
  approx: "≈",
  neq: "≠",
  leq: "≤",
  geq: "≥",
  infty: "∞"
};

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
  let inFence = false;
  let inlineCode = false;

  while (cursor < source.length) {
    if ((cursor === 0 || source[cursor - 1] === "\n") && /^(?:```|~~~)/.test(source.slice(cursor))) {
      const marker = source.slice(cursor).match(/^(?:```|~~~)/)?.[0] || "```";
      inFence = !inFence;
      markdown += marker;
      cursor += marker.length;
      continue;
    }
    if (!inFence && source[cursor] === "`") {
      inlineCode = !inlineCode;
      markdown += source[cursor++];
      continue;
    }
    if (inFence || inlineCode) {
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
      const bracketBody = bracketEnd < 0 ? "" : source.slice(cursor + 2, bracketEnd);
      if (bracketEnd >= 0 && /\\[A-Za-z]+/.test(bracketBody)) {
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
    markdown += display
      ? `\n<div data-math-token="${token}"></div>\n`
      : `<span data-math-token="${token}"></span>`;
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

function formulaFragment(source) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  const appendText = (text, className = "") => {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = text;
    fragment.append(span);
    return span;
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
      if (["text", "mathrm", "operatorname"].includes(command) && source[cursor] === "{") {
        const group = readGroup(source, cursor);
        appendText(group.value.replace(/\\([{}_])/g, "$1"), "math-roman");
        cursor = group.end;
        continue;
      }
      if (command === "overset" && source[cursor] === "{") {
        const top = readGroup(source, cursor);
        const base = readGroup(source, top.end);
        const stack = document.createElement("span");
        stack.className = "math-overset";
        const above = document.createElement("span");
        above.className = "math-over";
        above.append(formulaFragment(top.value));
        const below = document.createElement("span");
        below.className = "math-over-base";
        below.append(formulaFragment(base.value));
        stack.append(above, below);
        fragment.append(stack);
        cursor = base.end;
        continue;
      }
      appendText(commandSymbols[command] || `\\${command}`, commandSymbols[command] ? "math-symbol" : "math-unknown");
      continue;
    }
    if ((source[cursor] === "_" || source[cursor] === "^") && fragment.lastChild) {
      const kind = source[cursor] === "_" ? "sub" : "sup";
      const group = readGroup(source, cursor + 1);
      const script = document.createElement(kind);
      script.append(formulaFragment(group.value));
      fragment.append(script);
      cursor = group.end;
      continue;
    }
    if (source[cursor] === "{" || source[cursor] === "}") {
      cursor += 1;
      continue;
    }
    const plain = source.slice(cursor).match(/^[^\\{}_\^\s]+/)?.[0] || source[cursor];
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
    formula.append(formulaFragment(item.formula));
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
