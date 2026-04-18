import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts';
import { getBuiltinTheme, resolvePaneStyleOptions, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme';
import { buildFontFamily } from './layout-serialization';
export function applyTerminalAppearance(manager, settings, systemPrefersDark, paneFontSizes, paneTransports) {
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark);
    const paneStyles = resolvePaneStyleOptions(settings);
    const theme = appearance.theme ?? getBuiltinTheme(appearance.themeName);
    const paneBackground = theme?.background ?? '#000000';
    const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight);
    for (const pane of manager.getPanes()) {
        if (theme) {
            pane.terminal.options.theme = theme;
        }
        pane.terminal.options.cursorStyle = settings.terminalCursorStyle;
        pane.terminal.options.cursorBlink = settings.terminalCursorBlink;
        const paneSize = paneFontSizes.get(pane.id);
        pane.terminal.options.fontSize = paneSize ?? settings.terminalFontSize;
        pane.terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily);
        pane.terminal.options.fontWeight = terminalFontWeights.fontWeight;
        pane.terminal.options.fontWeightBold = terminalFontWeights.fontWeightBold;
        pane.terminal.options.macOptionIsMeta = settings.terminalMacOptionAsAlt === 'true';
        try {
            // Why: preserve scroll-to-bottom state across the reflow so appearance
            // changes (theme, font size, etc.) don't make the terminal scroll up.
            const buf = pane.terminal.buffer.active;
            const wasAtBottom = buf.viewportY >= buf.baseY;
            pane.fitAddon.fit();
            if (wasAtBottom) {
                pane.terminal.scrollToBottom();
            }
        }
        catch {
            /* ignore */
        }
        const transport = paneTransports.get(pane.id);
        if (transport?.isConnected()) {
            transport.resize(pane.terminal.cols, pane.terminal.rows);
        }
    }
    manager.setPaneStyleOptions({
        splitBackground: paneBackground,
        paneBackground,
        inactivePaneOpacity: paneStyles.inactivePaneOpacity,
        activePaneOpacity: paneStyles.activePaneOpacity,
        opacityTransitionMs: paneStyles.opacityTransitionMs,
        dividerThicknessPx: paneStyles.dividerThicknessPx,
        focusFollowsMouse: paneStyles.focusFollowsMouse
    });
}
