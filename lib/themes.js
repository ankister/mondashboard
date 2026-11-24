// Thèmes de l'interface : palettes sombres et claires, couleur d'accent et CSS personnalisé.
// Le serveur génère /theme.css ; le navigateur choisit la palette avec la classe th-dark / th-light sur <html>.

export const DARK = {
  'Ardoise': { bg: '#1f252c', bg2: '#262e36', card: '#2a333c', cardH: '#313b45', line: '#3a4550', text: '#effbff', muted: '#9aa9b5', accent: '#6ee2ff' },
  'Minuit': { bg: '#0d1117', bg2: '#161b22', card: '#161b22', cardH: '#1f2630', line: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#58a6ff' },
  'Nord': { bg: '#2e3440', bg2: '#353c4a', card: '#3b4252', cardH: '#434c5e', line: '#4c566a', text: '#eceff4', muted: '#a3adbf', accent: '#88c0d0' },
  'Dracula': { bg: '#282a36', bg2: '#2d2f3d', card: '#343746', cardH: '#3c3f52', line: '#4a4d63', text: '#f8f8f2', muted: '#a4a8c4', accent: '#bd93f9' },
  'Forêt': { bg: '#1b2420', bg2: '#202b26', card: '#24302a', cardH: '#2b3932', line: '#36463d', text: '#e8f3ec', muted: '#9db3a5', accent: '#7ddc9b' },
  'Café': { bg: '#221d1a', bg2: '#29231f', card: '#2e2723', cardH: '#372f2a', line: '#463c35', text: '#f5ede6', muted: '#b3a499', accent: '#f0a35e' }
};

export const LIGHT = {
  'Clair': { bg: '#eef1f5', bg2: '#ffffff', card: '#ffffff', cardH: '#f1f4f8', line: '#dbe1e8', text: '#1c2530', muted: '#5f6d7a', accent: '#0a84c6' },
  'Papier': { bg: '#f2ede4', bg2: '#fbf8f2', card: '#fffdf8', cardH: '#f4eee3', line: '#e0d6c4', text: '#2d261e', muted: '#6f6455', accent: '#b5651d' },
  'Nord clair': { bg: '#e5e9f0', bg2: '#f5f7fa', card: '#ffffff', cardH: '#eceff4', line: '#d3d9e3', text: '#2e3440', muted: '#5e6b80', accent: '#5e81ac' },
  'Menthe': { bg: '#eaf3ee', bg2: '#f7fbf8', card: '#ffffff', cardH: '#eef6f1', line: '#d3e3d9', text: '#1d2b24', muted: '#5b7065', accent: '#16915a' }
};

export const DEFAULT_THEME = { mode: 'auto', dark: 'Ardoise', light: 'Clair', accentDark: '', accentLight: '', css: '' };

const HEX = /^#[0-9a-f]{6}$/i;
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function cleanTheme(t = {}) {
  const o = { ...DEFAULT_THEME };
  if (['auto', 'sombre', 'clair'].includes(t.mode)) o.mode = t.mode;
  if (DARK[t.dark]) o.dark = t.dark;
  if (LIGHT[t.light]) o.light = t.light;
  if (HEX.test(t.accentDark || '')) o.accentDark = t.accentDark;
  if (HEX.test(t.accentLight || '')) o.accentLight = t.accentLight;
  // le CSS est servi comme feuille de style (jamais injecté dans du HTML)
  if (typeof t.css === 'string') o.css = t.css.slice(0, 100_000);
  return o;
}

function vars(p, accent, light) {
  const a = accent || p.accent;
  return `
  color-scheme: ${light ? 'light' : 'dark'};
  --bg: ${p.bg}; --bg2: ${p.bg2}; --card: ${p.card}; --card-h: ${p.cardH}; --line: ${p.line};
  --text: ${p.text}; --muted: ${p.muted}; --accent: ${a};
  --on-accent: ${lum(a) > 0.36 ? '#0d1b22' : '#ffffff'};
  --ok: ${light ? '#15924a' : '#4ade80'}; --warn: ${light ? '#c96d05' : '#fbbf24'}; --bad: ${light ? '#d42c2c' : '#f87171'};
  --line-soft: color-mix(in srgb, var(--line) ${light ? 80 : 55}%, transparent);
  --border-h: color-mix(in srgb, var(--line) 75%, var(--text));
  --dim: color-mix(in srgb, var(--muted) 60%, var(--bg));
  --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
  --overlay: ${light ? 'rgba(30, 40, 52, .38)' : 'rgba(8, 12, 16, .72)'};
  --shadow: ${light ? 'rgba(30, 40, 52, .16)' : 'rgba(0, 0, 0, .45)'};
  --wx-cloud: ${light ? '#7d8fa1' : '#e8f1fb'};`;
}

export function themeCss(raw) {
  const t = cleanTheme(raw);
  return `/* Généré par Mon dashboard — thème « ${t.dark} » / « ${t.light} » */
:root, :root.th-dark {${vars(DARK[t.dark], t.accentDark, false)}
}
:root.th-light {${vars(LIGHT[t.light], t.accentLight, true)}
}
${t.css ? `\n/* ---------- CSS personnalisé ---------- */\n${t.css}\n` : ''}`;
}

export const themeMeta = () => ({ dark: DARK, light: LIGHT });
