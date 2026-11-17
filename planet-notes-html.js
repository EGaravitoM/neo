'use strict';

(function () {
// The notes editor writes prose paragraphs and inline emphasis. External HTML
// outside this deliberately small language stays read-only, with its source
// untouched. A template keeps parsing inert (including resource-bearing nodes).
const tags = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'SUB', 'SUP']);
const styles = {
  'text-align': /^(left|right|center|justify)$/,
  'font-weight': /^(normal|bold|[1-9]00)$/,
  'font-style': /^(normal|italic)$/,
  'text-decoration': /^(none|underline|line-through|underline line-through)$/,
  'text-decoration-line': /^(none|underline|line-through|underline line-through)$/
};
// Manuscript-only markers may arrive through the shared paste cleaner. Keep
// their words as inert prose; Custom Notes does not own manuscript footnotes.
function flattenManuscriptMarkers(root) {
  for (const footnote of root.querySelectorAll('span.fn[data-note]')) {
    footnote.replaceWith(document.createTextNode(' (' + footnote.getAttribute('data-note') + ')'));
  }
  for (const marker of root.querySelectorAll('span.ph-mark')) {
    marker.replaceWith(document.createTextNode(marker.textContent || ''));
  }
}
function fromPaste(html) {
  const template = document.createElement('template'); template.innerHTML = html;
  flattenManuscriptMarkers(template.content);
  const checked = inspect(template.innerHTML);
  return checked.status === 'editable' ? checked.html : checked.copyHtml;
}
function inspect(html) {
  if (typeof html !== 'string') throw new TypeError('Expected note HTML');
  const template = document.createElement('template'); template.innerHTML = html;
  let supported = !/<!doctype|<\/?(?:html|head|body)\b/i.test(html);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== Node.ELEMENT_NODE) { supported = false; continue; }
    if (!tags.has(node.tagName)) supported = false;
    for (const attribute of node.attributes) {
      if (attribute.name === 'style') {
        // Check raw declarations too: CSSOM silently drops unknown/invalid CSS.
        const declarations = attribute.value.split(';').map((s) => s.trim()).filter(Boolean);
        for (const declaration of declarations) {
          const colon = declaration.indexOf(':');
          const name = declaration.slice(0, colon).trim().toLowerCase();
          const value = declaration.slice(colon + 1).trim().toLowerCase();
          if (colon < 0 || !styles[name] || !styles[name].test(value)) supported = false;
        }
      } else if (!(attribute.name === 'align' && ['P', 'DIV'].includes(node.tagName) && /^(left|right|center|justify)$/.test(attribute.value))) supported = false;
    }
  }
  if (supported) return { status: 'editable', html: template.innerHTML };
  // A plain-text preview cannot execute scripts, navigate links, load resources,
  // or activate custom elements. Script/style source is excluded from prose.
  flattenManuscriptMarkers(template.content);
  template.content.querySelectorAll('script,style,template,noscript').forEach((n) => n.remove());
  template.content.querySelectorAll('p,div,br,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr').forEach((n) => n.after(document.createTextNode('\n')));
  const text = template.content.textContent || '';
  const simplified = document.createElement('div');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p'); p.textContent = line; simplified.append(p);
  }
  return { status: 'unsupported', previewText: text, copyHtml: simplified.innerHTML || '<p><br></p>' };
}
const api = { inspect, fromPaste };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesHtml = api;
})();
