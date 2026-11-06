/** CSS.escape is missing in some environments (jsdom); this is the spec algorithm, simplified. */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  // Written with char codes on purpose: literal U+FFFF in a regex breaks Chrome's UTF-8 check.
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    if (code === 0) out += '�';
    else if (code < 0x20 || code === 0x7f || (isDigit && (i === 0 || (i === 1 && value[0] === '-'))))
      out += `\\${code.toString(16)} `;
    else if (code >= 0x80 || ch === '-' || ch === '_' || isDigit || /[a-zA-Z]/.test(ch))
      out += i === 0 && ch === '-' && value.length === 1 ? '\\-' : ch;
    else out += `\\${ch}`;
  }
  return out;
}

function isUnique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function attrSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  const value = el.getAttribute('value');
  if (name && value !== null) return `${tag}[name="${cssEscape(name)}"][value="${cssEscape(value)}"]`;
  if (name) return `${tag}[name="${cssEscape(name)}"]`;
  return null;
}

/**
 * Builds a selector that uniquely identifies `el`. Stable attributes first, so the selector
 * still works after the page reloads with the same markup.
 */
export function uniqueSelector(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id && isUnique(doc, `#${cssEscape(el.id)}`, el)) return `#${cssEscape(el.id)}`;
  const attr = attrSelector(el);
  if (attr && isUnique(doc, attr, el)) return attr;

  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== doc.documentElement) {
    if (node.id && node !== el) {
      parts.unshift(`#${cssEscape(node.id)}`);
      const sel = parts.join(' > ');
      if (isUnique(doc, sel, el)) return sel;
      parts.shift(); // duplicate id on the page: fall back to a positional part
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    let part = tag;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const sel = parts.join(' > ');
    if (isUnique(doc, sel, el)) return sel;
    node = parent;
  }
  return parts.join(' > ');
}
