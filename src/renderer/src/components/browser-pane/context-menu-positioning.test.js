import { describe, expect, it } from 'vitest';
/**
 * Tests for the browser context menu positioning pipeline.
 *
 * Pipeline:
 *   1. Main: captures screen.getCursorScreenPoint() at context-menu time
 *   2. Main: sends screenX/screenY + guest params.x/y to renderer
 *   3. Renderer: converts (screenX - window.screenX, screenY - window.screenY) / zoomFactor
 *   4. Renderer: createPortal(div, document.body), position: fixed at those coords
 *   5. Self-correction: useLayoutEffect measures getBoundingClientRect(),
 *      adjusts left/top if CSS containing blocks shifted the element
 *
 * Invariant: the context menu's top-left corner is at the cursor.
 */
function computeViewportCoords(screenX, screenY, windowScreenX, windowScreenY, zoomFactor) {
    return {
        x: Math.round((screenX - windowScreenX) / zoomFactor),
        y: Math.round((screenY - windowScreenY) / zoomFactor)
    };
}
function computeCorrection(targetX, targetY, measuredLeft, measuredTop) {
    const dx = targetX - measuredLeft;
    const dy = targetY - measuredTop;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        return { left: targetX + dx, top: targetY + dy, corrected: true };
    }
    return { left: targetX, top: targetY, corrected: false };
}
describe('screen-to-viewport coordinate conversion', () => {
    it('converts screen coords to viewport at zoom 1.0', () => {
        const result = computeViewportCoords(650, 400, 100, 50, 1.0);
        expect(result.x).toBe(550);
        expect(result.y).toBe(350);
    });
    it('converts screen coords to viewport at zoom 1.2', () => {
        // Screen cursor at (700, 500), window at (100, 50), zoom 1.2
        // Viewport = (600, 450) / 1.2 = (500, 375)
        const result = computeViewportCoords(700, 500, 100, 50, 1.2);
        expect(result.x).toBe(500);
        expect(result.y).toBe(375);
    });
    it('converts screen coords to viewport at zoom 0.8 (zoomed out)', () => {
        // (600 - 100) / 0.8 = 625
        const result = computeViewportCoords(600, 450, 100, 50, 0.8);
        expect(result.x).toBe(625);
        expect(result.y).toBe(500);
    });
    it('handles cursor at window origin', () => {
        const result = computeViewportCoords(100, 50, 100, 50, 1.0);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });
    it('handles cursor at window origin with zoom', () => {
        const result = computeViewportCoords(100, 50, 100, 50, 1.5);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });
});
describe('self-correction math', () => {
    it('no correction when position matches target', () => {
        const result = computeCorrection(300, 200, 300, 200);
        expect(result.corrected).toBe(false);
        expect(result.left).toBe(300);
        expect(result.top).toBe(200);
    });
    it('no correction for sub-pixel differences (within 1px)', () => {
        const result = computeCorrection(300, 200, 300.5, 200.8);
        expect(result.corrected).toBe(false);
    });
    it('corrects positive offset (ancestor pushed element right/down)', () => {
        const result = computeCorrection(300, 200, 350, 230);
        expect(result.left).toBe(250);
        expect(result.top).toBe(170);
        expect(result.corrected).toBe(true);
    });
    it('corrects negative offset (ancestor pulled element left/up)', () => {
        const result = computeCorrection(300, 200, 250, 170);
        expect(result.left).toBe(350);
        expect(result.top).toBe(230);
        expect(result.corrected).toBe(true);
    });
    it('corrected position reconstructs to target after same offset', () => {
        const target = { x: 400, y: 350 };
        const offset = { x: 50, y: 30 };
        const measured = { left: target.x + offset.x, top: target.y + offset.y };
        const result = computeCorrection(target.x, target.y, measured.left, measured.top);
        expect(result.left + offset.x).toBe(target.x);
        expect(result.top + offset.y).toBe(target.y);
    });
});
function computeEdgeFlip(cursorX, cursorY, menuWidth, menuHeight, viewportWidth, viewportHeight) {
    let x = cursorX;
    let y = cursorY;
    if (cursorX + menuWidth > viewportWidth) {
        x = cursorX - menuWidth;
    }
    if (cursorY + menuHeight > viewportHeight) {
        y = cursorY - menuHeight;
    }
    x = Math.max(0, x);
    y = Math.max(0, y);
    return { x, y };
}
describe('viewport edge flipping', () => {
    const menuW = 208;
    const menuH = 300;
    const vw = 1440;
    const vh = 900;
    it('no flip when menu fits entirely', () => {
        const result = computeEdgeFlip(400, 300, menuW, menuH, vw, vh);
        expect(result.x).toBe(400);
        expect(result.y).toBe(300);
    });
    it('flips left when menu overflows right edge', () => {
        const result = computeEdgeFlip(1400, 300, menuW, menuH, vw, vh);
        expect(result.x).toBe(1400 - menuW);
        expect(result.y).toBe(300);
    });
    it('flips up when menu overflows bottom edge', () => {
        const result = computeEdgeFlip(400, 750, menuW, menuH, vw, vh);
        expect(result.x).toBe(400);
        expect(result.y).toBe(750 - menuH);
    });
    it('flips both when menu overflows bottom-right corner', () => {
        const result = computeEdgeFlip(1400, 750, menuW, menuH, vw, vh);
        expect(result.x).toBe(1400 - menuW);
        expect(result.y).toBe(750 - menuH);
    });
    it('clamps to zero if flip would go negative', () => {
        const result = computeEdgeFlip(100, 50, menuW, menuH, vw, vh);
        // 100 + 208 = 308 < 1440, no flip needed horizontally
        expect(result.x).toBe(100);
        // 50 + 300 = 350 < 900, no flip needed vertically
        expect(result.y).toBe(50);
        // Small viewport forces flip, but cursor near origin clamps to 0
        const tight = computeEdgeFlip(50, 40, menuW, menuH, 200, 200);
        // 50 - 208 = -158 → clamped to 0
        expect(tight.x).toBe(0);
        // 40 - 300 = -260 → clamped to 0
        expect(tight.y).toBe(0);
    });
    it('exactly fits without flipping (edge-touching)', () => {
        // Menu right edge exactly at viewport: 1232 + 208 = 1440
        const result = computeEdgeFlip(1232, 600, menuW, menuH, vw, vh);
        expect(result.x).toBe(1232);
        expect(result.y).toBe(600);
    });
    it('flips when 1px past viewport', () => {
        // 1233 + 208 = 1441 > 1440
        const result = computeEdgeFlip(1233, 600, menuW, menuH, vw, vh);
        expect(result.x).toBe(1233 - menuW);
    });
});
describe('full pipeline', () => {
    it('screen coords at zoom 1.0 → correct viewport position', () => {
        const screenCursor = { x: 650, y: 400 };
        const windowPos = { x: 100, y: 50 };
        const menuPos = computeViewportCoords(screenCursor.x, screenCursor.y, windowPos.x, windowPos.y, 1.0);
        expect(menuPos.x).toBe(550);
        expect(menuPos.y).toBe(350);
    });
    it('screen coords at zoom 1.44 → correctly scaled viewport position', () => {
        // zoom level 2 → factor 1.2^2 = 1.44
        const screenCursor = { x: 388, y: 194 };
        const windowPos = { x: 100, y: 50 };
        const menuPos = computeViewportCoords(screenCursor.x, screenCursor.y, windowPos.x, windowPos.y, 1.44);
        expect(menuPos.x).toBe(200);
        expect(menuPos.y).toBe(100);
    });
    it('pipeline + self-correction compensates any CSS offset', () => {
        const screenCursor = { x: 650, y: 400 };
        const windowPos = { x: 100, y: 50 };
        const menuPos = computeViewportCoords(screenCursor.x, screenCursor.y, windowPos.x, windowPos.y, 1.0);
        const cssOffset = { x: 60, y: 40 };
        const measured = { left: menuPos.x + cssOffset.x, top: menuPos.y + cssOffset.y };
        const corrected = computeCorrection(menuPos.x, menuPos.y, measured.left, measured.top);
        expect(corrected.left + cssOffset.x).toBe(menuPos.x);
        expect(corrected.top + cssOffset.y).toBe(menuPos.y);
    });
    it('works without correction when no CSS offset exists', () => {
        const screenCursor = { x: 650, y: 400 };
        const windowPos = { x: 100, y: 50 };
        const menuPos = computeViewportCoords(screenCursor.x, screenCursor.y, windowPos.x, windowPos.y, 1.0);
        const corrected = computeCorrection(menuPos.x, menuPos.y, menuPos.x, menuPos.y);
        expect(corrected.corrected).toBe(false);
        expect(corrected.left).toBe(menuPos.x);
        expect(corrected.top).toBe(menuPos.y);
    });
});
