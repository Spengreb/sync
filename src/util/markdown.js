const XSS = require('../xss');

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function applyInlineMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1">');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
    return out;
}

function markdownToHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    let listItems = [];

    function flushParagraph() {
        if (!paragraph.length) return;
        const rendered = applyInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>');
        blocks.push('<p>' + rendered + '</p>');
        paragraph = [];
    }

    function flushList() {
        if (!listItems.length) return;
        blocks.push('<ul>' + listItems.map(item => '<li>' + applyInlineMarkdown(item) + '</li>').join('') + '</ul>');
        listItems = [];
    }

    lines.forEach(raw => {
        const line = raw.trim();
        if (!line) {
            flushParagraph();
            flushList();
            return;
        }

        if (/^[-*]\s+/.test(line)) {
            flushParagraph();
            listItems.push(line.replace(/^[-*]\s+/, ''));
            return;
        }

        if (/^#{1,3}\s+/.test(line)) {
            flushParagraph();
            flushList();
            const level = line.match(/^#{1,3}/)[0].length;
            const content = line.replace(/^#{1,3}\s+/, '');
            blocks.push('<h' + level + '>' + applyInlineMarkdown(content) + '</h' + level + '>');
            return;
        }

        paragraph.push(raw);
    });

    flushParagraph();
    flushList();

    return blocks.join('');
}

function looksLikeHtml(input) {
    return /<\/?[a-z][\s\S]*>/i.test(input || '');
}

function renderNotesHtml(input) {
    const notes = String(input || '').trim();
    if (!notes) return null;

    const html = looksLikeHtml(notes) ? notes : markdownToHtml(notes);
    return XSS.sanitizeHTML(html);
}

module.exports = {
    renderNotesHtml
};
