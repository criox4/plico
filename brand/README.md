# Plico logo kit

The mark is the app's own `BrandMark` (`src/ui.tsx`): a Plico Purple stem and a lighter bowl that overlap into a soft
lowercase **p**. The wordmark is that mark plus "lico" in Gabarito ExtraBold (800), outlined, so no font is needed.

| File | Use on |
|---|---|
| `plico-wordmark` | Light backgrounds (default) |
| `plico-wordmark-on-dark` | Dark backgrounds |
| `plico-wordmark-black` / `-white` | One-colour print, embossing, photos |
| `plico-mark` / `-on-dark` / `-black` / `-white` | Where the name is already nearby, avatars, small spaces |
| `plico-mascot` | The mark with eyes: onboarding, stickers, social |
| `plico-app-icon` / `-square` | Store listings, social avatars (square lets the platform round it) |
| `plico-favicon` | Browser tabs: bigger mark, no eyes |

Formats: `svg/` (source, scales anywhere), `png/` (transparent, sizes in the filename), `pdf/` (vector, for print).
Favicons live in `public/`: `favicon.svg` and `favicon.ico` (16, 32, 48).

## Rules

- **Colours:** Plico Purple `#6C5CE7` stem, bowl `#B3AAF2` (light) or `#C9C1FA` (dark and on purple), ink `#17171C`.
  The stem is always Plico Purple in colour versions.
- **Clear space:** at least the stem's width on every side.
- **Minimum size:** wordmark 72px wide on screen; mark 16px (use the favicon version below 32px).
- **Don't** recolour the stem, stretch, rotate, add shadows or outlines, or re-type "lico" in another font.
