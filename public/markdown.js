// Rendu Markdown minimal et sûr (le HTML saisi est toujours échappé).
// Gère : titres, gras, italique, barré, code, blocs de code, citations, listes
// (à puces, numérotées, cases à cocher), tableaux, liens, séparateurs.

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = u => (/^(https?:|mailto:)/i.test(u) ? u : '#');

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeHref(u.replace(/&amp;/g, '&'))}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/(^|[\s(])((https?:\/\/)[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function md(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };

  while (i < lines.length) {
    const line = lines[i];

    // bloc de code
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // tableau : ligne d'en-tête + ligne de séparation
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map(c => (/^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c, k) => `<th style="text-align:${align[k] || 'left'}">${inline(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${head.map((_, k) => `<td style="text-align:${align[k] || 'left'}">${inline(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    // listes (avec cases à cocher et indentation)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
        const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task
          ? `<li class="task" style="margin-left:${depth * 18}px"><input type="checkbox" data-line="${i}" ${task[1] !== ' ' ? 'checked' : ''}> <span${task[1] !== ' ' ? ' class="done"' : ''}>${inline(task[2])}</span></li>`
          : `<li style="margin-left:${depth * 18}px">${inline(m[3])}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

// Coche / décoche la case de la ligne n du source
export function toggleTask(src, n) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  lines[n] = lines[n].replace(/\[([ xX])\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
  return lines.join('\n');
}
