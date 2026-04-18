import { useEffect, useState } from 'react';
export function useSystemPrefersDark() {
    const [systemPrefersDark, setSystemPrefersDark] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : true);
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (event) => setSystemPrefersDark(event.matches);
        media.addEventListener('change', handleChange);
        return () => media.removeEventListener('change', handleChange);
    }, []);
    return systemPrefersDark;
}
