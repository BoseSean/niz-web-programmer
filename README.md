# NIZ Web Programmer — 84EC-S

A browser-based remapping tool for the **NIZ / Plum 84EC-S** electro-capacitive keyboard, using
[WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API). It replaces the Windows-only vendor software: read the
keyboard, remap keys on both layers, build combos / macros / emulate actions, and write back — all in the browser.

**Live app: https://bosesean.github.io/niz-web-programmer/**

Everything runs locally in your browser; nothing is uploaded. An independent, unofficial project — not affiliated with NIZ.

## Using it

- Open the live app in **Chrome or Edge** (WebHID needs a Chromium browser over HTTPS or localhost).
- Close the vendor KB84 software first — only one program can hold the keyboard's configuration interface at a time.
- Click **连接键盘**, pick the 84EC-S, and make sure programming mode is on (the **M** light on F12; hold Fn+F12 ~2 s).
- No keyboard handy? **使用模拟键盘** runs the whole UI against an in-browser simulated device.

## Develop

```bash
npm install
npm run dev            # http://localhost:5173 (Chrome / Edge)
npm run build          # static site in dist/
npx tsc -b --noEmit    # type check
npm run lint           # oxlint
```

`npm test` and `npm run gen:device` depend on reference data kept outside this repo and are not needed to build or run.

Pushing to `main` builds and deploys to GitHub Pages (`.github/workflows/deploy.yml`).

## Layout

| Folder | Contents |
|---|---|
| `src/device/` | key codes and layout, device constants |
| `src/protocol/` | slot model, packet codec, `KeyboardSession` (read / write / verify) |
| `src/transport/` | WebHID transport and the in-memory simulated keyboard |
| `src/format/` | keymap types, validation, compile to slots, JSON serializer, schema |
| `src/kb84/` | KB84 `.pro` import / export |
| `src/ui/`, `src/App.tsx` | the editor |
