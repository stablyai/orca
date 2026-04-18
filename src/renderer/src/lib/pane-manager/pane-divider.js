// ---------------------------------------------------------------------------
// Divider creation & drag-to-resize
// ---------------------------------------------------------------------------
/** Total hit area size = visible thickness + invisible padding on each side */
export function getDividerHitSize(styleOptions) {
    const thickness = styleOptions.dividerThicknessPx ?? 4;
    const HIT_PADDING = 3;
    return thickness + HIT_PADDING * 2;
}
export function createDivider(isVertical, styleOptions, callbacks) {
    const divider = document.createElement('div');
    divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`;
    // Ghostty-style: the element itself is a wide transparent hit area for easy
    // grabbing. The visible line is drawn by a CSS ::after pseudo-element
    // (see main.css), so `background` on the element stays transparent.
    const hitSize = getDividerHitSize(styleOptions);
    if (isVertical) {
        divider.style.width = `${hitSize}px`;
        divider.style.cursor = 'col-resize';
    }
    else {
        divider.style.height = `${hitSize}px`;
        divider.style.cursor = 'row-resize';
    }
    divider.style.flex = 'none';
    divider.style.position = 'relative';
    attachDividerDrag(divider, isVertical, callbacks);
    return divider;
}
function attachDividerDrag(divider, isVertical, callbacks) {
    const MIN_PANE_SIZE = 50;
    let dragging = false;
    let didMove = false;
    let startPos = 0;
    let prevFlex = 0;
    let nextFlex = 0;
    let totalSize = 0;
    let prevEl = null;
    let nextEl = null;
    const onPointerDown = (e) => {
        e.preventDefault();
        divider.setPointerCapture(e.pointerId);
        divider.classList.add('is-dragging');
        dragging = true;
        didMove = false;
        startPos = isVertical ? e.clientX : e.clientY;
        // Find previous and next pane/split siblings
        prevEl = divider.previousElementSibling;
        nextEl = divider.nextElementSibling;
        if (!prevEl || !nextEl) {
            return;
        }
        const prevRect = prevEl.getBoundingClientRect();
        const nextRect = nextEl.getBoundingClientRect();
        const prevSize = isVertical ? prevRect.width : prevRect.height;
        const nextSize = isVertical ? nextRect.width : nextRect.height;
        totalSize = prevSize + nextSize;
        // Store current proportions as flex-basis values
        prevFlex = prevSize;
        nextFlex = nextSize;
    };
    // Why: fitAddon.fit() triggers a full xterm.js reflow which can take
    // hundreds of ms with large scrollbacks. Gating behind rAF caps refit
    // to once per paint frame instead of once per pointer event (~250Hz).
    let refitRafId = null;
    const onPointerMove = (e) => {
        if (!dragging || !prevEl || !nextEl) {
            return;
        }
        didMove = true;
        const currentPos = isVertical ? e.clientX : e.clientY;
        const delta = currentPos - startPos;
        let newPrev = prevFlex + delta;
        let newNext = nextFlex - delta;
        // Enforce minimum pane size
        if (newPrev < MIN_PANE_SIZE) {
            newPrev = MIN_PANE_SIZE;
            newNext = totalSize - MIN_PANE_SIZE;
        }
        if (newNext < MIN_PANE_SIZE) {
            newNext = MIN_PANE_SIZE;
            newPrev = totalSize - MIN_PANE_SIZE;
        }
        // Use flex-grow proportionally
        prevEl.style.flex = `${newPrev} 1 0%`;
        nextEl.style.flex = `${newNext} 1 0%`;
        // Refit terminals in affected panes (throttled to one per animation frame)
        if (refitRafId === null) {
            const p = prevEl;
            const n = nextEl;
            refitRafId = requestAnimationFrame(() => {
                refitRafId = null;
                callbacks.refitPanesUnder(p);
                callbacks.refitPanesUnder(n);
            });
        }
    };
    const onPointerUp = (e) => {
        if (!dragging) {
            return;
        }
        dragging = false;
        if (refitRafId !== null) {
            cancelAnimationFrame(refitRafId);
            refitRafId = null;
        }
        divider.releasePointerCapture(e.pointerId);
        divider.classList.remove('is-dragging');
        // Final refit at the exact drop position
        if (prevEl) {
            callbacks.refitPanesUnder(prevEl);
        }
        if (nextEl) {
            callbacks.refitPanesUnder(nextEl);
        }
        prevEl = null;
        nextEl = null;
        // Persist updated ratios after a real drag
        if (didMove) {
            callbacks.onLayoutChanged?.();
        }
    };
    // Ghostty-style: double-click divider to equalize sibling panes
    const onDoubleClick = () => {
        const prev = divider.previousElementSibling;
        const next = divider.nextElementSibling;
        if (!prev || !next) {
            return;
        }
        prev.style.flex = '1 1 0%';
        next.style.flex = '1 1 0%';
        callbacks.refitPanesUnder(prev);
        callbacks.refitPanesUnder(next);
        callbacks.onLayoutChanged?.();
    };
    divider.addEventListener('pointerdown', onPointerDown);
    divider.addEventListener('pointermove', onPointerMove);
    divider.addEventListener('pointerup', onPointerUp);
    divider.addEventListener('dblclick', onDoubleClick);
}
export function applyDividerStyles(root, styleOptions) {
    const thickness = styleOptions.dividerThicknessPx ?? 4;
    const hitSize = getDividerHitSize(styleOptions);
    const dividers = root.querySelectorAll('.pane-divider');
    for (const div of dividers) {
        const el = div;
        const isVertical = el.classList.contains('is-vertical');
        if (isVertical) {
            el.style.width = `${hitSize}px`;
        }
        else {
            el.style.height = `${hitSize}px`;
        }
        // Store the visual thickness for the CSS ::after pseudo-element
        el.style.setProperty('--divider-thickness', `${thickness}px`);
        // Extension amount lets ::after reach the center of perpendicular
        // dividers so intersecting splits visually connect.
        el.style.setProperty('--divider-extension', `${hitSize / 2}px`);
    }
}
export function applyPaneOpacity(panes, activePaneId, styleOptions) {
    const { activePaneOpacity = 1, inactivePaneOpacity = 1, opacityTransitionMs = 0 } = styleOptions;
    const transition = opacityTransitionMs > 0 ? `opacity ${opacityTransitionMs}ms ease` : '';
    for (const pane of panes) {
        const isActive = pane.id === activePaneId;
        pane.container.style.opacity = String(isActive ? activePaneOpacity : inactivePaneOpacity);
        pane.container.style.transition = transition;
    }
}
export function applyRootBackground(root, styleOptions) {
    if (styleOptions.splitBackground) {
        root.style.background = styleOptions.splitBackground;
    }
}
