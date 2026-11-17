// The reconnect card's stylesheet, copied from the VM page glue (orca-desktop-page.js) in
// stablyai/orca-cloud: cloud/apps/sandbox-control/image/vm. That repository's tests fail when the two
// drift (desktop-parity.test.ts there), so a page restyle updates this copy in the same change.
export const REMOTE_DESKTOP_PAGE_CSS = `
#noVNC_connect_dlg, #noVNC_control_bar_anchor { display: none !important; }
#orca_pause { --orca-scrim: rgb(10 10 10 / 0.88); --orca-card: #171717; --orca-text: #f0f0f0;
  --orca-border: rgb(255 255 255 / 0.1); --orca-control: rgb(255 255 255 / 0.25);
  --orca-control-hover: rgb(255 255 255 / 0.08); --orca-focus: color-mix(in oklab, #f0f0f0 65%, #0a0a0a);
  color-scheme: dark; position: fixed; inset: 0; display: none; align-items: center;
  justify-content: center; padding: 16px; background: var(--orca-scrim); z-index: 1000;
  font: 13px/1.5 system-ui, sans-serif; }
@media (prefers-color-scheme: light) {
  #orca_pause { --orca-scrim: rgb(255 255 255 / 0.88); --orca-card: #fff; --orca-text: #0a0a0a;
    --orca-border: #e5e5e5; --orca-control: #a3a3a3; --orca-control-hover: #f5f5f5;
    --orca-focus: color-mix(in oklab, #0a0a0a 55%, #fff); color-scheme: light; }
}
#orca_pause.open { display: flex; }
#orca_pause > div { max-width: 360px; padding: 16px; border: 1px solid var(--orca-border);
  border-radius: 8px; background: var(--orca-card); color: var(--orca-text); text-align: center;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.16); }
#orca_pause p { margin: 0; }
#orca_pause button { margin-top: 12px; padding: 4px 12px; border: 1px solid var(--orca-control);
  border-radius: 6px; background: transparent; color: var(--orca-text); font: inherit; cursor: pointer; }
#orca_pause button:hover { background: var(--orca-control-hover); }
#orca_pause button:focus-visible { outline: 2px solid var(--orca-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) {
  #orca_pause.open > div { animation: orca-pause-in 120ms ease-out; }
}
@keyframes orca-pause-in { from { opacity: 0; transform: translateY(4px); } }
`
