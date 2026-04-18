import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
export function LazySection({ index, onVisible, children }) {
    const ref = useRef(null);
    const triggered = useRef(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || triggered.current) {
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting && !triggered.current) {
                triggered.current = true;
                onVisible(index);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(el);
        return () => observer.disconnect();
    }, [index, onVisible]);
    return (_jsx("div", { ref: ref, className: "border-b border-border", children: children }));
}
