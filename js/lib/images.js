// Product mock-up illustrations, generated as SVG from each item's category and colours.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function shade(hex, amt) {
  const n = parseInt((hex || '#C8A27A').slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function shortName(name) {
  return String(name).replace(/ Mini Tin$/, '').replace(/^The /, '');
}
const backdrop = id => `
  <defs>
    <linearGradient id="sky${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F8F1E6"/><stop offset="1" stop-color="#EFE3D0"/></linearGradient>
  </defs>
  <rect width="200" height="200" fill="url(#sky${id})"/>
  <path d="M0 150 L40 112 L64 132 L100 92 L134 128 L160 108 L200 140 L200 200 L0 200 Z" fill="#9CAF88" opacity=".35"/>
  <path d="M0 168 L50 140 L90 158 L130 136 L200 162 L200 200 L0 200 Z" fill="#9CAF88" opacity=".45"/>
  <ellipse cx="100" cy="178" rx="62" ry="7" fill="#3B2F20" opacity=".12"/>`;
const flame = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
  <path d="M0 -22 C6 -13 8 -8 6 -3 C4 2 -4 2 -6 -3 C-8 -8 -4 -13 0 -22 Z" fill="#F2A33A"/>
  <path d="M0 -14 C3 -9 3 -6 2 -4 C1 -1 -2 -1 -2 -4 C-3 -6 -2 -9 0 -14 Z" fill="#FCE7A8"/>
  <line x1="0" y1="0" x2="0" y2="5" stroke="#2F2B24" stroke-width="1.6"/></g>`;

export function productSVG(item, size = 200) {
  const id = Math.random().toString(36).slice(2, 7);
  const c = item.color_hex || '#C8A27A', a = item.accent_hex || '#4F6B4A';
  const nm = esc(shortName(item.name));
  const fs = nm.length > 16 ? 8 : nm.length > 12 ? 9.5 : 11;
  let art = '';
  switch (item.category) {
    case 'candle_8oz':
      art = `
      <defs><linearGradient id="g${id}" x1="0" x2="1"><stop offset="0" stop-color="#7A4416"/><stop offset=".45" stop-color="#B26A2A"/><stop offset="1" stop-color="#6A3A12"/></linearGradient></defs>
      <rect x="58" y="70" width="84" height="104" rx="12" fill="url(#g${id})"/>
      <ellipse cx="100" cy="74" rx="40" ry="8" fill="${c}"/><ellipse cx="100" cy="74" rx="40" ry="8" fill="none" stroke="${shade(c, -30)}" stroke-width="1.5"/>
      ${flame(100, 70, 1.15)}
      <rect x="62" y="104" width="76" height="46" rx="4" fill="#E9D9BE"/>
      <rect x="62" y="104" width="76" height="6" fill="${a}"/>
      <text x="100" y="125" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="${fs}" font-weight="700" fill="#2F2B24">${nm}</text>
      <text x="100" y="138" text-anchor="middle" font-family="Inter, sans-serif" font-size="6.5" fill="#5C5548" letter-spacing="1">EMBLET CO. · 8 OZ</text>
      <rect x="66" y="80" width="6" height="86" rx="3" fill="#fff" opacity=".18"/>`;
      break;
    case 'mini_tin':
      art = `
      <ellipse cx="100" cy="150" rx="46" ry="14" fill="#8E8E8E"/>
      <rect x="54" y="118" width="92" height="32" fill="#BDBDBD"/>
      <ellipse cx="100" cy="118" rx="46" ry="14" fill="${c}"/>
      ${flame(100, 116, 1)}
      <g transform="translate(150 70) rotate(18)"><ellipse cx="0" cy="0" rx="34" ry="12" fill="#D6D6D6" stroke="#9B9B9B"/>
        <ellipse cx="0" cy="-1" rx="24" ry="8" fill="#E9D9BE"/><rect x="-24" y="-3" width="48" height="2" fill="${a}"/></g>
      <rect x="44" y="160" width="112" height="22" rx="4" fill="#E9D9BE" opacity=".95"/>
      <text x="100" y="175" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="${fs}" font-weight="700" fill="#2F2B24">${nm}</text>`;
      break;
    case 'soap':
      art = `
      <g transform="rotate(-6 100 125)">
        <rect x="46" y="92" width="108" height="66" rx="12" fill="${c}"/>
        <rect x="46" y="92" width="108" height="16" rx="8" fill="#fff" opacity=".22"/>
        ${item.sku === 'SOAP-LEMON' ? Array.from({ length: 26 }, (_, i) => `<circle cx="${54 + (i * 37) % 96}" cy="${98 + (i * 23) % 54}" r="1.1" fill="#2F2B24" opacity=".6"/>`).join('') : ''}
        ${item.sku === 'SOAP-OAT' ? Array.from({ length: 18 }, (_, i) => `<ellipse cx="${54 + (i * 41) % 96}" cy="${98 + (i * 29) % 54}" rx="2.4" ry="1.2" fill="#B89A6A" opacity=".7"/>`).join('') : ''}
        <rect x="82" y="88" width="36" height="74" fill="#C8A27A"/>
        <rect x="82" y="88" width="36" height="74" fill="none" stroke="#94704A" stroke-width="1"/>
        <text x="100" y="128" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="7" font-weight="700" fill="#2F2B24" transform="rotate(-90 100 125)">${nm}</text>
      </g>
      <circle cx="152" cy="74" r="7" fill="#fff" opacity=".7"/><circle cx="164" cy="62" r="4" fill="#fff" opacity=".6"/><circle cx="142" cy="60" r="3" fill="#fff" opacity=".6"/>`;
      break;
    case 'gift_set':
      art = `
      <rect x="40" y="96" width="120" height="78" rx="6" fill="#B08A5E"/>
      <rect x="34" y="84" width="132" height="22" rx="4" fill="#C49C6C"/>
      <rect x="92" y="84" width="16" height="90" fill="${a}"/>
      <path d="M100 84 C82 62 70 70 78 82 C82 88 94 86 100 84 Z" fill="${a}"/><path d="M100 84 C118 62 130 70 122 82 C118 88 106 86 100 84 Z" fill="${shade(a, -20)}"/>
      <g transform="translate(132 132) rotate(-12)"><rect x="-22" y="-12" width="44" height="26" rx="3" fill="#F5EBDD" stroke="#94704A"/>
        <circle cx="-17" cy="0" r="2" fill="#94704A"/><text x="3" y="4" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="6.5" font-weight="700" fill="#2F2B24">Gift Set</text></g>
      <rect x="44" y="146" width="62" height="20" rx="3" fill="#F5EBDD" opacity=".92"/>
      <text x="75" y="159" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="${nm.length > 14 ? 6 : 7.5}" font-weight="700" fill="#2F2B24">${nm}</text>
      <circle cx="${100}" cy="${96}" r="5" fill="${c}"/>`;
      break;
    case 'accessory':
      art = item.sku === 'ACC-DISH'
        ? `<ellipse cx="100" cy="140" rx="64" ry="22" fill="${c}"/><ellipse cx="100" cy="134" rx="54" ry="15" fill="${shade(c, 25)}"/>
           ${[0, 1, 2, 3, 4].map(i => `<rect x="${72 + i * 12}" y="128" width="5" height="12" rx="2" fill="${shade(c, -25)}"/>`).join('')}
           <rect x="76" y="104" width="48" height="26" rx="8" fill="#A58FC4"/>`
        : `<g transform="rotate(-30 100 120)"><circle cx="70" cy="128" r="14" fill="none" stroke="${c}" stroke-width="6"/><circle cx="96" cy="128" r="14" fill="none" stroke="${c}" stroke-width="6"/>
           <path d="M80 118 L150 106 L152 112 L84 128 Z" fill="${c}"/><path d="M86 128 L150 128 L150 134 L86 136 Z" fill="${shade(c, 30)}"/></g>`;
      break;
    default: // raw materials
      art = `<rect x="62" y="80" width="76" height="92" rx="10" fill="${c}" stroke="${shade(c, -40)}" stroke-width="2"/>
             <rect x="74" y="66" width="52" height="18" rx="4" fill="${shade(c, -40)}"/>
             <rect x="66" y="112" width="68" height="34" rx="3" fill="#F5EBDD"/>
             <text x="100" y="128" text-anchor="middle" font-family="Inter, sans-serif" font-size="7" font-weight="700" fill="#2F2B24">${esc(item.sku)}</text>
             <text x="100" y="139" text-anchor="middle" font-family="Inter, sans-serif" font-size="6" fill="#5C5548">${esc(item.uom || '')}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="${esc(item.name)} mock-up">${backdrop(id)}${art}</svg>`;
}

export function productImg(item, cls = 'img') {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = productSVG(item);
  return d;
}
