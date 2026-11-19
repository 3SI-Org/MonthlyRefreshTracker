// Atlassian Document Format (ADF) -> the small markdown dialect the page's md.js renders.
// Mentions become <custom data-type="mention">@Name</custom>, the same shape the Atlassian
// MCP connector returned, so the page's "Asks @Name" detection keeps working.

const esc = (s) => String(s || '');

function marks(text, list) {
  let out = text;
  for (const m of list || []) {
    if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'code') out = '`' + out + '`';
    else if (m.type === 'link' && m.attrs && m.attrs.href) out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes) {
  return (nodes || []).map((n) => {
    switch (n.type) {
      case 'text': return marks(esc(n.text), n.marks);
      case 'hardBreak': return '\n';
      case 'mention': {
        const name = esc((n.attrs && (n.attrs.text || n.attrs.displayName)) || '@someone');
        return `<custom data-type="mention" data-id="${esc(n.attrs && n.attrs.id)}">${name.startsWith('@') ? name : '@' + name}</custom>`;
      }
      case 'emoji': return esc((n.attrs && (n.attrs.text || n.attrs.shortName)) || '');
      case 'inlineCard': return esc(n.attrs && n.attrs.url);
      case 'date': return n.attrs && n.attrs.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
      case 'status': return esc(n.attrs && n.attrs.text);
      case 'mediaInline': return '[file]';
      default: return n.content ? inline(n.content) : '';
    }
  }).join('');
}

function block(n, depth = 0) {
  switch (n.type) {
    case 'paragraph': return inline(n.content);
    case 'heading': return `${'#'.repeat((n.attrs && n.attrs.level) || 3)} ${inline(n.content)}`;
    case 'bulletList':
    case 'orderedList':
      return (n.content || []).map((li, i) => {
        const [first, ...rest] = li.content || [];
        const bullet = n.type === 'orderedList' ? `${i + 1}.` : '-';
        const lines = [`${'  '.repeat(depth)}${bullet} ${first ? (first.type === 'paragraph' ? inline(first.content) : block(first, depth + 1)) : ''}`];
        for (const r of rest) lines.push(block(r, depth + 1));
        return lines.join('\n');
      }).join('\n');
    case 'codeBlock': return '```\n' + (n.content || []).map((t) => t.text || '').join('') + '\n```';
    case 'blockquote': return (n.content || []).map((c) => block(c, depth)).join('\n\n');
    case 'panel': return (n.content || []).map((c) => block(c, depth)).join('\n\n');
    case 'rule': return '';
    case 'table': {
      const rows = (n.content || []).map((tr) => '| ' + (tr.content || []).map((cell) => (cell.content || []).map((c) => block(c, depth)).join(' ').replace(/\n/g, ' ').replace(/\|/g, '/')).join(' | ') + ' |');
      if (rows.length) rows.splice(1, 0, '|' + rows[0].split('|').slice(1, -1).map(() => ' --- ').join('|') + '|');
      return rows.join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup': return '[image]';
    case 'expand':
    case 'nestedExpand': return `**${esc(n.attrs && n.attrs.title)}**\n\n` + (n.content || []).map((c) => block(c, depth)).join('\n\n');
    default: return n.content ? (n.content || []).map((c) => block(c, depth)).join('\n\n') : '';
  }
}

export function adfToMarkdown(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  if (doc.type !== 'doc') return block(doc);
  return (doc.content || []).map((n) => block(n)).filter((s) => s !== '').join('\n\n');
}
