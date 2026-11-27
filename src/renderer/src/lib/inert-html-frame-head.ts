// Keep untrusted markup inert with an opaque-origin, script-free frame and no-network CSP; sandboxing blocks link popups.
export const INERT_HTML_FRAME_HEAD = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<base target="_blank">`
