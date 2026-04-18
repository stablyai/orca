'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
const createRays = (count, cycle) => {
    if (count <= 0) {
        return [];
    }
    return Array.from({ length: count }, (_, index) => {
        const left = 8 + Math.random() * 84;
        const rotate = -28 + Math.random() * 56;
        const width = 160 + Math.random() * 160;
        const swing = 0.8 + Math.random() * 1.8;
        const delay = Math.random() * cycle;
        const duration = cycle * (0.75 + Math.random() * 0.5);
        const intensity = 0.6 + Math.random() * 0.5;
        return {
            id: `${index}-${Math.round(left * 10)}`,
            left,
            rotate,
            width,
            swing,
            delay,
            duration,
            intensity
        };
    });
};
/**
 * Why: CSS-only implementation of the magic-ui LightRays component to avoid
 * adding a framer-motion dependency. Uses CSS @keyframes for the fade+swing
 * animation cycle that the original drives with motion.animate.
 */
function Ray({ left, rotate, width, swing, delay, duration, intensity }) {
    const animName = `ray-fade-swing`;
    return (_jsx("div", { 
        // Why: dropped mix-blend-screen — it forced an extra offscreen
        // compositing pass over each ray's bounding region every frame. The
        // additive glow look is approximated by slightly boosting the gradient
        // alpha and keeping willChange on so the layer stays on the compositor.
        className: "pointer-events-none absolute -top-[12%] h-[var(--light-rays-length)] origin-top -translate-x-1/2 rounded-full bg-linear-to-b from-[color-mix(in_srgb,var(--light-rays-color)_85%,transparent)] to-transparent blur-[var(--light-rays-blur)]", style: {
            left: `${left}%`,
            width: `${width}px`,
            '--ray-intensity': intensity,
            '--ray-swing': `${swing}deg`,
            '--ray-rotate': `${rotate}deg`,
            animation: `${animName} ${duration}s ease-in-out ${delay}s infinite`,
            transform: `translateX(-50%) rotate(${rotate}deg)`,
            // Why: promote each ray to its own compositor layer so the
            // keyframe animation runs off the main thread. Without this,
            // Chromium rasterizes every swing tick on the UI thread which
            // stalls React renders while the NewWorkspace page mounts.
            willChange: 'transform, opacity'
        } }));
}
export function LightRays({ className, style, count = 7, color = 'rgba(160, 210, 255, 0.2)', blur = 36, speed = 14, length = '70vh', ref, ...props }) {
    // Why: users with prefers-reduced-motion should get a static backdrop
    // instead of an animated composite layer — both an accessibility and a
    // perf win on low-end GPUs.
    const prefersReducedMotion = useMemo(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return false;
        }
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }, []);
    const effectiveCount = prefersReducedMotion ? 0 : count;
    const [rays, setRays] = useState([]);
    const cycleDuration = Math.max(speed, 0.1);
    useEffect(() => {
        setRays(createRays(effectiveCount, cycleDuration));
    }, [effectiveCount, cycleDuration]);
    return (_jsxs("div", { ref: ref, className: cn('pointer-events-none absolute inset-0 isolate overflow-hidden rounded-[inherit]', className), style: {
            '--light-rays-color': color,
            '--light-rays-blur': `${blur}px`,
            '--light-rays-length': length,
            ...style
        }, ...props, children: [_jsx("style", { children: `
        @keyframes ray-fade-swing {
          0%, 100% { opacity: 0; transform: translateX(-50%) rotate(calc(var(--ray-rotate, 0deg) - var(--ray-swing, 1deg))); }
          50% { opacity: var(--ray-intensity, 0.7); transform: translateX(-50%) rotate(calc(var(--ray-rotate, 0deg) + var(--ray-swing, 1deg))); }
        }
      ` }), _jsxs("div", { className: "absolute inset-0 overflow-hidden", children: [_jsx("div", { "aria-hidden": true, className: "absolute inset-0 opacity-60", style: {
                            background: 'radial-gradient(circle at 20% 15%, color-mix(in srgb, var(--light-rays-color) 45%, transparent), transparent 70%)'
                        } }), _jsx("div", { "aria-hidden": true, className: "absolute inset-0 opacity-60", style: {
                            background: 'radial-gradient(circle at 80% 10%, color-mix(in srgb, var(--light-rays-color) 35%, transparent), transparent 75%)'
                        } }), rays.map((ray) => (_jsx(Ray, { ...ray }, ray.id)))] })] }));
}
