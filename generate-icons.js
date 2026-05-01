/**
 * Icon Generator for DHIS2 Context Lens
 * 
 * Run with: node generate-icons.js
 * 
 * Generates PNG icons at 16x16, 48x48, and 128x128 using Canvas.
 * If canvas is unavailable, falls back to creating SVG files.
 */

const fs = require('fs');
const path = require('path');

// SVG template for the Context Lens icon
function generateSVG(size) {
  const scale = size / 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2563eb"/>
      <stop offset="100%" style="stop-color:#1d4ed8"/>
    </linearGradient>
  </defs>
  <!-- Background circle -->
  <circle cx="64" cy="64" r="60" fill="url(#bg)" />
  <!-- Magnifying glass body -->
  <circle cx="52" cy="52" r="28" fill="none" stroke="white" stroke-width="8" opacity="0.95"/>
  <!-- Magnifying glass handle -->
  <line x1="72" y1="72" x2="100" y2="100" stroke="white" stroke-width="10" stroke-linecap="round" opacity="0.95"/>
  <!-- Data icon (bars) inside lens -->
  <rect x="38" y="42" width="6" height="20" rx="2" fill="white" opacity="0.8"/>
  <rect x="48" y="36" width="6" height="26" rx="2" fill="white" opacity="0.8"/>
  <rect x="58" y="46" width="6" height="16" rx="2" fill="white" opacity="0.8"/>
  <!-- Small sparkle (AI indicator) -->
  <circle cx="96" cy="28" r="8" fill="#fbbf24" opacity="0.9"/>
  <text x="96" y="33" text-anchor="middle" fill="white" font-size="12" font-weight="bold">✦</text>
</svg>`;
}

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

sizes.forEach(size => {
  const svg = generateSVG(size);
  const svgPath = path.join(iconsDir, `icon${size}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`Created ${svgPath}`);
});

console.log(`
✅ SVG icons created! 

To convert SVGs to PNGs (required by Chrome):
  Option 1: Use an online converter (svgtopng.com)
  Option 2: Install 'sharp' or 'canvas' npm package
  Option 3: Use ImageMagick: convert icon128.svg icon128.png

Or use the data-URI PNG fallback below.
`);

// Also generate a simple inline PNG using a 1-pixel approach for testing
// This creates minimal valid PNGs that Chrome can load
const { createCanvas } = (() => {
  try {
    return require('canvas');
  } catch {
    return { createCanvas: null };
  }
})();

if (createCanvas) {
  sizes.forEach(size => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Background circle
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#2563eb');
    gradient.addColorStop(1, '#1d4ed8');

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.47, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Magnifying glass
    ctx.strokeStyle = 'white';
    ctx.lineWidth = size * 0.06;
    ctx.beginPath();
    ctx.arc(size * 0.41, size * 0.41, size * 0.22, 0, Math.PI * 2);
    ctx.stroke();

    // Handle
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(size * 0.56, size * 0.56);
    ctx.lineTo(size * 0.78, size * 0.78);
    ctx.stroke();

    const pngPath = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));
    console.log(`Created PNG: ${pngPath}`);
  });
} else {
  console.log('Note: Install "canvas" npm package to auto-generate PNGs: npm install canvas');
}
