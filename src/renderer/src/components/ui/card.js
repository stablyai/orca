import { jsx as _jsx } from "react/jsx-runtime";
import { cn } from '@/lib/utils';
function Card({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card", className: cn('flex flex-col gap-6 rounded-xl border border-border/50 bg-card py-6 text-card-foreground shadow-sm', className), ...props }));
}
function CardHeader({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card-header", className: cn('@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6', className), ...props }));
}
function CardTitle({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card-title", className: cn('leading-none font-semibold', className), ...props }));
}
function CardDescription({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card-description", className: cn('text-sm text-muted-foreground', className), ...props }));
}
function CardAction({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card-action", className: cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className), ...props }));
}
function CardContent({ className, ...props }) {
    return _jsx("div", { "data-slot": "card-content", className: cn('px-6', className), ...props });
}
function CardFooter({ className, ...props }) {
    return (_jsx("div", { "data-slot": "card-footer", className: cn('flex items-center px-6 [.border-t]:pt-6', className), ...props }));
}
export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
