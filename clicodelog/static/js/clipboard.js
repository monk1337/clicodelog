function exportConversation() {
    if (!currentProjectId || !currentSessionId) return;
    var a = document.createElement('a');
    a.href = '/api/projects/' + currentProjectId + '/sessions/' + currentSessionId + '/export?source=' + currentSource;
    a.download = currentSessionId + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function copyConversation() {
    if (!currentConversation) return;
    try {
        await navigator.clipboard.writeText(buildConversationText(currentConversation));
        var btn = document.getElementById('copy-btn');
        var label = btn.querySelector('span:last-child');
        var orig = label.textContent;
        label.textContent = 'Copied!';
        setTimeout(function() { label.textContent = orig; }, 2000);
    } catch (e) { alert('Failed to copy to clipboard'); }
}

function buildConversationText(conv) {
    var sep60 = '============================================================';
    var sep40 = '----------------------------------------';
    var sep60dash = '------------------------------------------------------------';
    var lines = [sep60, 'Session: ' + conv.session_id, 'Source: ' + currentSource, sep60, ''];
    if (conv.summaries && conv.summaries.length > 0) {
        lines.push('SUMMARIES:');
        conv.summaries.forEach(function(s) { lines.push('  \u2022 ' + s); });
        lines.push('', sep60dash, '');
    }
    conv.messages.forEach(function(msg) {
        lines.push('[' + msg.role.toUpperCase() + '] ' + (msg.timestamp || ''));
        if (msg.model) lines.push('Model: ' + msg.model);
        lines.push(sep40);
        if (msg.content) lines.push(msg.content);
        if (msg.thinking) lines.push('', '--- THINKING ---', msg.thinking, '--- END THINKING ---');
        if (msg.tool_uses && msg.tool_uses.length > 0) {
            lines.push('');
            msg.tool_uses.forEach(function(tool) {
                lines.push('[TOOL: ' + tool.name + ']');
                if (typeof tool.input === 'object') {
                    Object.entries(tool.input).forEach(function(entry) {
                        var val = String(entry[1]);
                        lines.push('  ' + entry[0] + ': ' + (val.length > 200 ? val.substring(0, 200) + '...' : val));
                    });
                } else {
                    lines.push('  ' + (tool.input || ''));
                }
            });
        }
        if (msg.usage) lines.push('\n[Tokens: ' + ((msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0)) + ']');
        lines.push('', sep60, '');
    });
    return lines.join('\n');
}
