export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
export function button(text: string, click: () => void): HTMLButtonElement {
    const node = el('button', text); node.type = 'button'; node.addEventListener('click', click); return node;
}
export function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), a = el('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
