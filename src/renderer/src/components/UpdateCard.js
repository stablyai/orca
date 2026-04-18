import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the update card owns the full updater lifecycle in one
   renderer surface. Keeping the state machine and its presentation variants together avoids
   scattering tightly coupled update behavior across multiple files. */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
// ── Helpers ──────────────────────────────────────────────────────────
function releaseUrlForVersion(version) {
    return version
        ? `https://github.com/stablyai/orca/releases/tag/v${version}`
        : 'https://github.com/stablyai/orca/releases/latest';
}
function isAnimatedGif(url) {
    return typeof url === 'string' && url.toLowerCase().endsWith('.gif');
}
// ── Compact card (transient check feedback) ─────────────────────────
function CompactCardContent({ icon, text, onClose, action }) {
    return (_jsxs("div", { className: "flex items-center gap-3 p-3", children: [_jsxs("div", { className: "shrink-0 text-muted-foreground", children: [icon === 'spinner' && _jsx(Loader2, { className: "size-4 animate-spin" }), icon === 'check' && _jsx(Check, { className: "size-4" }), icon === 'error' && _jsx(AlertCircle, { className: "size-4" })] }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-sm truncate", children: text }), action && (_jsx("button", { className: "text-xs text-muted-foreground underline hover:text-foreground mt-0.5", onClick: () => void window.api.shell.openUrl(action.url), children: action.label }))] }), onClose && (_jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0", onClick: onClose, "aria-label": "Dismiss", children: _jsx(X, { className: "size-3.5" }) }))] }));
}
// ── Main component ──────────────────────────────────────────────────
export function UpdateCard() {
    const status = useAppStore((s) => s.updateStatus);
    const storeChangelog = useAppStore((s) => s.updateChangelog);
    const dismissedVersion = useAppStore((s) => s.dismissedUpdateVersion);
    const dismissUpdate = useAppStore((s) => s.dismissUpdate);
    const reassuranceSeen = useAppStore((s) => s.updateReassuranceSeen);
    const markReassuranceSeen = useAppStore((s) => s.markUpdateReassuranceSeen);
    const hasStartedDownload = useRef(false);
    const [mediaFailed, setMediaFailed] = useState(false);
    const [mediaLoaded, setMediaLoaded] = useState(false);
    const [installError, setInstallError] = useState(null);
    // Why: the version-based dismiss gate at the bottom of the visibility
    // section intentionally keeps error cards visible so a download failure
    // still surfaces even if the user previously dismissed the "available"
    // card for the same version.  But this means the error card's own X
    // button cannot hide the card via dismissUpdate alone.  A separate
    // local flag tracks whether the user has explicitly closed the error
    // card in this render cycle.
    const [errorDismissed, setErrorDismissed] = useState(false);
    // Why: "not-available" is transient feedback ("You're up to date") that
    // should auto-dismiss. A local flag avoids polluting the store with
    // timer state that no other component cares about.
    const [autoDismissed, setAutoDismissed] = useState(false);
    // Why: tracks whether the card is exiting so we can play the fade-out
    // animation before unmounting.
    const [exiting, setExiting] = useState(false);
    // Why: when the user explicitly clicks "Check for Updates", the dismiss gate
    // must be bypassed for the resulting 'available' card — otherwise the card
    // flashes "Checking..." then vanishes because the same version was previously
    // dismissed.  This ref tracks whether the current check cycle was user-initiated
    // so the dismiss gate can let the result through.
    const userInitiatedCycleRef = useRef(false);
    const changelog = storeChangelog;
    // Why: the 'error' variant of UpdateStatus does not carry a `version` field,
    // but the card needs the version for the "Download Manually" fallback URL
    // and for dismiss persistence. Cache it from states that do carry it.
    const versionRef = useRef(null);
    if ('version' in status && status.version) {
        versionRef.current = status.version;
    }
    else if (status.state === 'checking' ||
        status.state === 'idle' ||
        status.state === 'not-available') {
        // Why: a new check cycle has started or completed without an available update.
        // Clear the cached version so a later check failure cannot dismiss or link to
        // an unrelated older release that happened to be cached locally.
        versionRef.current = null;
    }
    // Why: reset component-local state when a new update cycle begins. Without
    // this, stale flags from a previous version leak forward — e.g., a failed
    // image load for version A would suppress the hero for version B, or a
    // hasStartedDownload flag from version A would cause a Settings-initiated
    // download for version B to auto-restart.
    const prevVersionRef = useRef(null);
    if (status.state === 'available' && status.version !== prevVersionRef.current) {
        prevVersionRef.current = status.version;
        hasStartedDownload.current = false;
        setMediaFailed(false);
        setMediaLoaded(false);
        setInstallError(null);
    }
    // Why: reset autoDismissed when a new status arrives so the card is
    // visible again for the next user-initiated check cycle.
    const prevStateRef = useRef(status.state);
    if (status.state !== prevStateRef.current) {
        prevStateRef.current = status.state;
        if (autoDismissed) {
            setAutoDismissed(false);
        }
        if (exiting) {
            setExiting(false);
        }
        if (errorDismissed) {
            setErrorDismissed(false);
        }
    }
    const shouldAutoDismissLatest = status.state === 'not-available' && 'userInitiated' in status && Boolean(status.userInitiated);
    // Why: auto-dismiss "You're on the latest version" after 3 seconds.
    // The timer resets if the status changes before it fires.
    useEffect(() => {
        if (!shouldAutoDismissLatest) {
            return;
        }
        const timer = setTimeout(() => setAutoDismissed(true), 3000);
        return () => clearTimeout(timer);
    }, [shouldAutoDismissLatest]);
    // Why: quitAndInstall is a side effect that must not run during render —
    // React StrictMode double-invokes render functions, which would call
    // quitAndInstall twice. useEffect with a state guard is the safe path.
    // Gated on hasStartedDownload so a Settings-initiated download doesn't
    // auto-restart the app — the user expects to click "Restart" in Settings.
    useEffect(() => {
        if (status.state === 'downloaded' && hasStartedDownload.current) {
            void window.api.updater.quitAndInstall().catch((error) => {
                setInstallError(String(error?.message ?? error));
            });
        }
    }, [status.state]);
    // ── Prefers-reduced-motion ──────────────────────────────────────────
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setPrefersReducedMotion(mq.matches);
        const handler = (e) => setPrefersReducedMotion(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);
    // ── Visibility gates ──────────────────────────────────────────────
    const isUserInitiated = 'userInitiated' in status && status.userInitiated;
    const cachedVersion = versionRef.current;
    const shouldShowDetailedErrorCard = status.state === 'error' && (hasStartedDownload.current || cachedVersion !== null);
    // Why: track whether the current check cycle was user-initiated so the
    // dismiss gate doesn't hide the result of an explicit "Check for Updates"
    // click.  Without this, clicking "Check for Updates" when a version was
    // previously dismissed causes the "Checking..." toast to flash briefly
    // then vanish — the 'available' card is suppressed by the dismiss gate
    // even though the user explicitly asked to see the result.
    if (status.state === 'checking' && isUserInitiated) {
        userInitiatedCycleRef.current = true;
    }
    else if (status.state === 'idle' || (status.state === 'checking' && !isUserInitiated)) {
        userInitiatedCycleRef.current = false;
    }
    // Compact transient states: only show for user-initiated checks.
    if (status.state === 'checking' && !isUserInitiated) {
        return null;
    }
    if (status.state === 'not-available' && !isUserInitiated) {
        return null;
    }
    if (status.state === 'not-available' && autoDismissed) {
        return null;
    }
    // Background states that never show the card.
    if (status.state === 'idle') {
        return null;
    }
    // Error: show card for user-initiated check failures or for failures tied to
    // a concrete cached update version (card-initiated and Settings-initiated
    // download/install flows). Background check failures stay silent.
    if (status.state === 'error' && !shouldShowDetailedErrorCard && !isUserInitiated) {
        return null;
    }
    // Why: the version-based dismiss gate below intentionally keeps error cards
    // visible, but when the user explicitly clicks X on the error card itself
    // the card must disappear. This gate handles that case.
    if (status.state === 'error' && errorDismissed) {
        return null;
    }
    // Dismiss gate: if the user previously dismissed this version, hide the card
    // for passive reminder states. Keep active in-progress/error states visible so
    // explicit install actions can still surface progress and failures.
    // Why: bypass the gate when the current cycle was user-initiated — the user
    // explicitly asked to check, so they expect to see the result even if they
    // dismissed the same version earlier.
    if (versionRef.current &&
        dismissedVersion === versionRef.current &&
        !userInitiatedCycleRef.current) {
        if (status.state !== 'downloading' && status.state !== 'error') {
            return null;
        }
    }
    // ── Shared helpers ────────────────────────────────────────────────
    const isRichMode = changelog?.release != null;
    const handleUpdate = () => {
        hasStartedDownload.current = true;
        // Why: clicking "Update" implies the user is not worried about interruption,
        // so dismiss the reassurance tip permanently.
        if (!reassuranceSeen) {
            markReassuranceSeen();
        }
        void window.api.updater.download();
    };
    // Why: the 'error' variant has no version field, so dismiss needs an
    // optional explicit version override for error/install-failure states.
    const handleClose = () => {
        // Why: clear the user-initiated bypass so the dismiss gate re-engages
        // immediately — otherwise the card would reappear on the next render
        // because the bypass ref still overrides the persisted dismissal.
        userInitiatedCycleRef.current = false;
        if (status.state === 'error') {
            setErrorDismissed(true);
            if (cachedVersion) {
                dismissUpdate(cachedVersion);
            }
            return;
        }
        dismissUpdate();
    };
    const handleInstallRetry = () => {
        void window.api.updater.quitAndInstall().catch((error) => {
            setInstallError(String(error?.message ?? error));
        });
    };
    const errorCard = status.state === 'error'
        ? {
            title: 'Update Error',
            summary: cachedVersion
                ? 'Could not complete the update.'
                : 'Could not check for updates.',
            message: status.message,
            releaseUrl: releaseUrlForVersion(cachedVersion),
            primaryAction: cachedVersion
                ? {
                    label: 'Retry Download',
                    onClick: handleUpdate
                }
                : undefined
        }
        : installError
            ? {
                title: 'Update Error',
                summary: 'Could not restart to install the update.',
                message: installError,
                releaseUrl: releaseUrlForVersion(cachedVersion),
                primaryAction: {
                    label: 'Try Again',
                    onClick: handleInstallRetry
                }
            }
            : null;
    const handleDismissWithAnimation = () => {
        if (prefersReducedMotion) {
            handleClose();
            return;
        }
        setExiting(true);
        setTimeout(handleClose, 150);
    };
    // Escape key handler for accessibility
    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            handleDismissWithAnimation();
        }
    };
    // ── Dynamic aria-label ────────────────────────────────────────────
    const ariaLabel = status.state === 'checking'
        ? 'Checking for updates'
        : status.state === 'not-available'
            ? "You're on the latest version"
            : status.state === 'available'
                ? 'Update available'
                : status.state === 'downloading'
                    ? 'Downloading update'
                    : status.state === 'downloaded'
                        ? 'Update ready to install'
                        : status.state === 'error'
                            ? 'Update error'
                            : 'Update status';
    // ── Card wrapper ──────────────────────────────────────────────────
    const animationClass = prefersReducedMotion
        ? ''
        : exiting
            ? 'animate-update-card-exit'
            : 'animate-update-card-enter';
    const cardContent = (() => {
        // ── Compact transient states (user-initiated check feedback) ──────
        if (status.state === 'checking') {
            return _jsx(CompactCardContent, { icon: "spinner", text: "Checking for updates..." });
        }
        if (status.state === 'not-available') {
            return _jsx(CompactCardContent, { icon: "check", text: "You're on the latest version." });
        }
        // ── Error states ─────────────────────────────────────────────────
        if (errorCard) {
            return (_jsx(ErrorCardContent, { title: errorCard.title, summary: errorCard.summary, message: errorCard.message, releaseUrl: errorCard.releaseUrl, primaryAction: errorCard.primaryAction, onClose: handleDismissWithAnimation }));
        }
        // ── Downloaded state ─────────────────────────────────────────────
        if (status.state === 'downloaded') {
            if (hasStartedDownload.current) {
                return (_jsx("div", { className: "p-4", children: _jsx("p", { className: "text-sm", children: "Installing..." }) }));
            }
            // Settings-initiated download — show "Ready to install"
            return (_jsx(ReadyToInstallContent, { version: status.version, onRestart: handleInstallRetry, onClose: handleDismissWithAnimation }));
        }
        // ── Downloading state ────────────────────────────────────────────
        if (status.state === 'downloading') {
            return (_jsx(DownloadingContent, { version: status.version, percent: status.percent, changelog: changelog, prefersReducedMotion: prefersReducedMotion, mediaFailed: mediaFailed, mediaLoaded: mediaLoaded, onMediaError: () => setMediaFailed(true), onMediaLoad: () => setMediaLoaded(true) }));
        }
        // ── Available state ──────────────────────────────────────────────
        if (status.state !== 'available') {
            return null;
        }
        const releaseUrl = ('releaseUrl' in status ? status.releaseUrl : undefined) ??
            releaseUrlForVersion(status.version);
        if (isRichMode && changelog) {
            return (_jsx(RichCardContent, { release: changelog.release, releasesBehind: changelog.releasesBehind, prefersReducedMotion: prefersReducedMotion, mediaFailed: mediaFailed, mediaLoaded: mediaLoaded, onMediaError: () => setMediaFailed(true), onMediaLoad: () => setMediaLoaded(true), onUpdate: handleUpdate, onClose: handleDismissWithAnimation }));
        }
        return (_jsx(SimpleCardContent, { version: status.version, releaseUrl: releaseUrl, onUpdate: handleUpdate, onClose: handleDismissWithAnimation }));
    })();
    // Why: show a one-time reassurance tip above the card so first-time users
    // know updating won't kill their running terminals. Once seen, persisted
    // to disk so it never reappears.
    const showReassurance = !reassuranceSeen && (status.state === 'available' || status.state === 'downloading');
    return (_jsxs("div", { className: "fixed bottom-10 right-4 z-40 w-[360px] max-w-[calc(100vw-32px)] flex flex-col gap-2\n      max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto", children: [showReassurance && (_jsx(Card, { className: `py-0 gap-0 ${animationClass}`, children: _jsxs("div", { className: "flex items-center gap-3 p-3", children: [_jsx("div", { className: "flex-1 min-w-0", children: _jsx("p", { className: "text-xs text-muted-foreground", children: "Your terminal sessions won't be interrupted during the update." }) }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0", onClick: markReassuranceSeen, "aria-label": "Dismiss tip", children: _jsx(X, { className: "size-3.5" }) })] }) })), _jsx(Card, { role: "complementary", "aria-label": ariaLabel, "aria-live": "polite", tabIndex: -1, onKeyDown: handleKeyDown, className: `py-0 gap-0 ${animationClass}`, children: cardContent })] }));
}
// ── Rich card content ────────────────────────────────────────────────
function RichCardContent({ release, releasesBehind, prefersReducedMotion, mediaFailed, mediaLoaded, onMediaError, onMediaLoad, onUpdate, onClose }) {
    const showMedia = release.mediaUrl &&
        !mediaFailed &&
        // Why: when prefers-reduced-motion is active, hide animated GIFs entirely
        // rather than showing a frozen frame (GIFs cannot be reliably paused
        // cross-browser). Static images are shown normally since they produce no motion.
        !(prefersReducedMotion && isAnimatedGif(release.mediaUrl));
    return (_jsxs("div", { className: "flex flex-col gap-3 p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsxs("h3", { className: "text-sm font-semibold", children: ["New: ", release.title] }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2", onClick: onClose, "aria-label": "Dismiss update", children: _jsx(X, { className: "size-3.5" }) })] }), showMedia && (_jsxs("div", { className: "relative overflow-hidden rounded-md", children: [!mediaLoaded && (
                    // Shimmer placeholder while image loads
                    _jsx("div", { className: "w-full bg-muted/50 animate-pulse rounded-md", style: { aspectRatio: '16/9' } })), _jsx("img", { src: release.mediaUrl, alt: "", className: `w-full rounded-md ${mediaLoaded ? '' : 'absolute inset-0'}`, style: !mediaLoaded ? { visibility: 'hidden' } : undefined, onError: onMediaError, onLoad: onMediaLoad })] })), _jsxs("p", { className: "text-sm text-muted-foreground", children: [release.description, releasesBehind !== null && releasesBehind > 1 && (_jsxs(_Fragment, { children: [' ', _jsxs("button", { className: "text-xs text-muted-foreground/70 underline hover:text-foreground inline", onClick: () => void window.api.shell.openUrl(release.releaseNotesUrl), children: ["+", releasesBehind - 1, " more since your last update"] })] }))] }), _jsx("button", { className: "text-xs text-muted-foreground underline hover:text-foreground self-start", onClick: () => void window.api.shell.openUrl(release.releaseNotesUrl), children: "Read the full release notes" }), _jsx(Button, { variant: "default", size: "sm", onClick: onUpdate, className: "w-full", children: "Update" })] }));
}
// ── Simple card content ──────────────────────────────────────────────
function SimpleCardContent({ version, releaseUrl, onUpdate, onClose }) {
    return (_jsxs("div", { className: "flex flex-col gap-2.5 p-3.5", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Update Available" }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2", onClick: onClose, "aria-label": "Dismiss update", children: _jsx(X, { className: "size-3.5" }) })] }), _jsxs("p", { className: "text-sm text-muted-foreground", children: ["Orca v", version, " is ready."] }), _jsx("p", { className: "text-xs leading-relaxed text-muted-foreground", children: "Sessions won't be interrupted." }), _jsx("button", { className: "text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground self-start", onClick: () => void window.api.shell.openUrl(releaseUrl), children: "Release notes" }), _jsx(Button, { variant: "default", size: "sm", onClick: onUpdate, className: "mt-0.5 w-full", children: "Update" })] }));
}
// ── Downloading content ──────────────────────────────────────────────
function DownloadingContent({ version, percent, changelog, prefersReducedMotion, mediaFailed, mediaLoaded, onMediaError, onMediaLoad }) {
    const release = changelog?.release;
    const showMedia = release?.mediaUrl && !mediaFailed && !(prefersReducedMotion && isAnimatedGif(release.mediaUrl));
    return (_jsxs("div", { className: "flex flex-col gap-3 p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [release ? (_jsxs("h3", { className: "text-sm font-semibold", children: ["New: ", release.title] })) : (_jsx("h3", { className: "text-sm font-semibold", children: "Downloading Update" })), _jsx("div", { className: "size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2" })] }), showMedia && release?.mediaUrl && (_jsxs("div", { className: "relative overflow-hidden rounded-md", children: [!mediaLoaded && (_jsx("div", { className: "w-full bg-muted/50 animate-pulse rounded-md", style: { aspectRatio: '16/9' } })), _jsx("img", { src: release.mediaUrl, alt: "", className: `w-full rounded-md ${mediaLoaded ? '' : 'absolute inset-0'}`, style: !mediaLoaded ? { visibility: 'hidden' } : undefined, onError: onMediaError, onLoad: onMediaLoad })] })), _jsx("p", { className: "text-sm text-muted-foreground", children: release ? release.description : `Orca v${version} is downloading.` }), _jsx("button", { className: "text-xs text-muted-foreground underline hover:text-foreground self-start", onClick: () => void window.api.shell.openUrl(release ? release.releaseNotesUrl : releaseUrlForVersion(version)), children: release ? 'Read the full release notes' : 'Release notes' }), _jsxs("div", { className: "flex flex-col gap-2 mt-1", children: [_jsx(Progress, { value: percent, className: "h-1.5" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Downloading... ", percent, "%"] })] })] }));
}
// ── Error card content ───────────────────────────────────────────────
function ErrorCardContent({ title, summary, message, releaseUrl, primaryAction, onClose }) {
    return (_jsxs("div", { className: "flex flex-col gap-3 p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h3", { className: "text-sm font-semibold", children: title }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2", onClick: onClose, "aria-label": "Dismiss", children: _jsx(X, { className: "size-3.5" }) })] }), _jsxs("p", { className: "text-sm text-muted-foreground", children: [summary, " ", message] }), _jsxs("div", { className: "flex gap-2", children: [primaryAction && (_jsx(Button, { variant: "default", size: "sm", onClick: primaryAction.onClick, className: "flex-1", children: primaryAction.label })), _jsx(Button, { variant: "outline", size: "sm", onClick: () => void window.api.shell.openUrl(releaseUrl), className: primaryAction ? 'flex-1' : 'w-full', children: "Download Manually" })] })] }));
}
// ── Ready to install content ─────────────────────────────────────────
function ReadyToInstallContent({ version, onRestart, onClose }) {
    return (_jsxs("div", { className: "flex flex-col gap-3 p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Ready to Install" }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2", onClick: onClose, "aria-label": "Dismiss", children: _jsx(X, { className: "size-3.5" }) })] }), _jsxs("p", { className: "text-sm text-muted-foreground", children: ["Orca v", version, " is downloaded. Restart when you're ready."] }), _jsx(Button, { variant: "default", size: "sm", onClick: onRestart, className: "w-full", children: "Restart to Update" })] }));
}
