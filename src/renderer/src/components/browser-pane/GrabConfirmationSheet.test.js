import { describe, expect, it } from 'vitest';
import { formatGrabPayloadAsText } from './GrabConfirmationSheet';
function makeTestPayload(overrides) {
    return {
        page: {
            sanitizedUrl: 'https://example.com/pricing',
            title: 'Pricing - Example',
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            devicePixelRatio: 2,
            capturedAt: '2026-04-10T00:00:00.000Z'
        },
        target: {
            tagName: 'button',
            selector: 'main section:nth-of-type(2) button.primary',
            textSnippet: 'Start free trial',
            htmlSnippet: '<button class="primary">Start free trial</button>',
            attributes: { class: 'primary', type: 'button' },
            accessibility: {
                role: 'button',
                accessibleName: 'Start free trial',
                ariaLabel: null,
                ariaLabelledBy: null
            },
            rectViewport: { x: 400, y: 300, width: 148, height: 44 },
            rectPage: { x: 400, y: 300, width: 148, height: 44 },
            computedStyles: {
                display: 'inline-flex',
                position: 'relative',
                width: '148px',
                height: '44px',
                margin: '0px',
                padding: '12px 24px',
                color: 'rgb(255, 255, 255)',
                backgroundColor: 'rgb(99, 102, 241)',
                border: '0px none',
                borderRadius: '8px',
                fontFamily: 'Inter, sans-serif',
                fontSize: '16px',
                fontWeight: '600',
                lineHeight: '20px',
                textAlign: 'center',
                zIndex: 'auto'
            }
        },
        nearbyText: ['Pro', '$29/month', 'Unlimited projects'],
        ancestorPath: ['section', 'main', 'body'],
        screenshot: null,
        ...overrides
    };
}
describe('formatGrabPayloadAsText', () => {
    it('formats a complete payload with all sections', () => {
        const text = formatGrabPayloadAsText(makeTestPayload());
        expect(text).toContain('Attached browser context from https://example.com/pricing');
        expect(text).toContain('Selected element:');
        expect(text).toContain('button');
        expect(text).toContain('Accessible name: "Start free trial"');
        expect(text).toContain('Selector: main section:nth-of-type(2) button.primary');
        expect(text).toContain('148x44');
        expect(text).toContain('Nearby context:');
        expect(text).toContain('- Pro');
        expect(text).toContain('- $29/month');
        expect(text).toContain('HTML:');
        expect(text).toContain('<button class="primary">Start free trial</button>');
    });
    it('omits nearby context section when empty', () => {
        const text = formatGrabPayloadAsText(makeTestPayload({ nearbyText: [] }));
        expect(text).not.toContain('Nearby context:');
    });
    it('omits text content section when empty', () => {
        const payload = makeTestPayload();
        payload.target.textSnippet = '';
        const text = formatGrabPayloadAsText(payload);
        expect(text).not.toContain('Text content:');
    });
    it('includes computed styles that differ from defaults', () => {
        const text = formatGrabPayloadAsText(makeTestPayload());
        expect(text).toContain('Computed styles:');
        expect(text).toContain('display: inline-flex');
        expect(text).toContain('position: relative');
        expect(text).toContain('font-size: 16px');
    });
    it('includes ancestor path', () => {
        const text = formatGrabPayloadAsText(makeTestPayload());
        expect(text).toContain('Ancestor path: section > main > body');
    });
    it('handles payload with no accessible name', () => {
        const payload = makeTestPayload();
        payload.target.accessibility.accessibleName = null;
        const text = formatGrabPayloadAsText(payload);
        expect(text).not.toContain('Accessible name:');
    });
});
