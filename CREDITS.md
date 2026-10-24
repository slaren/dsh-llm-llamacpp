# Credits

## llama.brand

The llama.cpp mark in `icon.svg` and in the client's pill and dialog title
(`Icon()` in `client.js`) is the official asset from
[ggml-org/llama.brand](https://github.com/ggml-org/llama.brand)
(`icon/icon-light.svg`, `icon/icon-dark.svg`).

Those assets are licensed under [CC BY-NC 4.0](https://github.com/ggml-org/llama.brand/blob/master/LICENSE),
and [`BRAND-USAGE.md`](https://github.com/ggml-org/llama.brand/blob/master/BRAND-USAGE.md)
additionally grants everyone permission to reproduce and redistribute the marks,
including commercially and as part of software distributions, packages and
operating systems, for the purpose of identifying or referring to Llama.app and
Llama.cpp. That permission covers rescaling, monochrome or single-colour
rendering, format conversion and embedding into package metadata.

The mark is used here to identify the llama.cpp server this plugin reads. Its
shape is **not** redrawn: both copies differ only in scale and in being rendered
in a single colour.

- In the client (`Icon()` in `client.js`, used by the dock pill and the dialog
  title) the fill is `currentColor`, so the mark always takes the colour of the
  surface it sits on — the pill's own label colour, including its hover state.
- `icon.svg` is a standalone package asset, where `currentColor` would resolve to
  black and vanish on a dark surface. It therefore follows
  `prefers-color-scheme`. A host whose theme disagrees with the reader's system
  scheme is the one case a single monochrome file cannot cover.

This plugin is not affiliated with or endorsed by ggml-org.
