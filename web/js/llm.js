/**
 * LLM-Erweiterung: Rastergröße, LLMFinder (spricht mit server.py) und das LLM-Log.
 */

/**
 * Rastergröße: füllt standardmäßig die Fläche links von den Panels.
 * Überschreibbar mit ?cols=..&rows=..&size=.. in der URL.
 */
var LLMConfig = (function() {
    var PANEL_SPACE = 330, params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function(pair) {
        var kv = pair.split('=');
        if (kv[0]) { params[kv[0]] = parseInt(kv[1], 10); }
    });
    var size = params.size > 0 ? params.size : 44;
    return {
        size: size,
        cols: params.cols > 0 ? params.cols : Math.max(8, Math.floor((window.innerWidth - PANEL_SPACE) / size)),
        rows: params.rows > 0 ? params.rows : Math.max(5, Math.floor(window.innerHeight / size))
    };
})();


/**
 * Ein "Finder", der die Suche an server.py schickt und das Ergebnis streamt.
 * @param {Object} opt  { mode, memory, thinking, view, temperature, maxSteps }
 */
function LLMFinder(opt) {
    this.opt = opt;
    this.isAsync = true;
}

/**
 * Prüft Start und Ziel.
 * @return {string|null}  Fehlermeldung, oder null wenn alles passt
 */
LLMFinder.prototype.checkPoints = function(sx, sy, ex, ey, grid) {
    var points = [['Start', sx, sy], ['Ziel', ex, ey]];
    for (var i = 0; i < points.length; ++i) {
        var name = points[i][0], x = points[i][1], y = points[i][2];
        if (!grid.isInside(x, y)) {
            return name + ' (' + x + ', ' + y + ') liegt außerhalb des Rasters.';
        }
        if (!grid.isWalkableAt(x, y)) {
            return name + ' (' + x + ', ' + y + ') liegt auf einer Wand.';
        }
    }
    return null;
};

/**
 * Startet den Lauf auf dem Server.
 * @param {Object} cb  { onEvent(ev), onDone(result), onError(message) };
 *                     am Ende kommt genau einmal onDone oder onError.
 */
LLMFinder.prototype.run = function(sx, sy, ex, ey, grid, cb) {
    var self = this, error = this.checkPoints(sx, sy, ex, ey, grid);
    if (error) {
        setTimeout(function() { cb.onError(error); }, 0);
        return;
    }

    var walls = [];
    for (var y = 0; y < grid.height; ++y) {
        var row = [];
        for (var x = 0; x < grid.width; ++x) {
            row.push(grid.isWalkableAt(x, y) ? 0 : 1);
        }
        walls.push(row);
    }

    this.runId = Math.random().toString(36).slice(2);
    this.abortController = new AbortController();
    this.finished = false;

    var finishOnce = function(fn, arg) {
        if (!self.finished) {
            self.finished = true;
            fn(arg);
        }
    };

    fetch('/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abortController.signal,
        body: JSON.stringify({
            run: this.runId, walls: walls, start: [sx, sy], end: [ex, ey],
            mode: this.opt.mode, memory: this.opt.memory, thinking: this.opt.thinking,
            view: this.opt.mode === 'oneshot' ? 0 : this.opt.view,
            temperature: this.opt.temperature, max_steps: this.opt.maxSteps,
            delay_ms: LLMLog.delay()
        })
    }).then(function(res) {
        if (!res.ok) {
            return res.text().then(function(text) {
                var message;
                try { message = JSON.parse(text).error; } catch (e) { message = text; }
                throw new Error('Server-Fehler ' + res.status + ': ' + (message || res.statusText));
            });
        }
        return self.readLines(res.body.getReader(), function(ev) {
            if (ev.type === 'error') { throw new Error(ev.message); }
            if (ev.type === 'done') { finishOnce(cb.onDone, ev); return false; }
            if (ev.type !== 'ping') { cb.onEvent(ev); }
            return true;
        });
    }).then(function() {
        if (!self.finished) {
            throw new Error('Verbindung beendet, bevor der Lauf fertig war ' +
                            '(Absturz? Terminal von server.py prüfen).');
        }
    }).catch(function(e) {
        if (e.name === 'AbortError') { return; }
        var message = e.message || String(e);
        if (e instanceof TypeError) {
            message = 'Server nicht erreichbar – läuft server.py? (' + message + ')';
        }
        finishOnce(cb.onError, message);
    });
};

/**
 * Liest den Stream Zeile für Zeile und ruft handle(event) für jede JSON-Zeile auf.
 * Gibt handle false zurück, wird nicht weitergelesen.
 * @return {Promise}  erfüllt, wenn der Stream zu Ende ist
 */
LLMFinder.prototype.readLines = function(reader, handle) {
    var decoder = new TextDecoder(), buffer = '';
    var next = function() {
        return reader.read().then(function(chunk) {
            if (chunk.value) { buffer += decoder.decode(chunk.value, { stream: true }); }
            var lines = buffer.split('\n');
            buffer = chunk.done ? '' : lines.pop();
            for (var i = 0; i < lines.length; ++i) {
                if (lines[i].trim() && handle(JSON.parse(lines[i])) === false) { return; }
            }
            return chunk.done ? undefined : next();
        });
    };
    return next();
};

/** Schickt pause / resume / cancel / delay an den laufenden Lauf. */
LLMFinder.prototype.control = function(action, extra) {
    if (!this.runId || this.finished) { return; }
    fetch('/llm/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify($.extend({ run: this.runId, action: action }, extra))
    }).catch(function() {});
};
LLMFinder.prototype.pause = function() { this.control('pause'); };
LLMFinder.prototype.resume = function() { this.control('resume'); };
LLMFinder.prototype.setDelay = function(ms) { this.control('delay', { delay_ms: ms }); };
LLMFinder.prototype.abort = function() {
    if (this.finished) { return; }
    this.control('cancel');
    this.finished = true;
    this.abortController.abort();
};


/**
 * Das LLM-Log-Panel: eine Zeile pro Schritt, dazu Thinking, One-Shot-Text und Prompt.
 */
var LLMLog = {
    MAX_ENTRIES: 1500,

    init: function() {
        var self = this;
        this.$panel = $('#llm_log_panel');
        this.$log = $('#llm_log');
        this.$prompt = $('#llm_prompt');
        this.prompts = {};

        $('#llm_speed').on('input change', function() {
            self.updateSpeedLabel();
            if (Controller.asyncFinder) { Controller.asyncFinder.setDelay(self.delay()); }
        });
        this.updateSpeedLabel();
        $('#llm_show_prompt').change(function() { self.$prompt.toggle(this.checked); });
        this.$log.on('click', '.llm_entry', function() {
            var n = $(this).data('n');
            if (self.prompts[n]) { self.showPrompt(self.prompts[n], n); }
        });
    },

    /** @return {number} gewählte Pause pro Schritt in ms */
    delay: function() {
        return parseInt($('#llm_speed').val(), 10) || 0;
    },
    updateSpeedLabel: function() {
        $('#llm_speed_label').text(this.delay() === 0 ? 'max.' : this.delay() + ' ms');
    },
    /** Zeigt die Statuszeile über dem Log; isError färbt sie rot. */
    status: function(text, isError) {
        $('#llm_status').text(text).toggleClass('error', !!isError);
    },
    show: function(visible) {
        this.$panel.toggle(visible);
        if (visible) {
            var $play = $('#play_panel');
            this.$panel.css({ top: $play.offset().top + $play.outerHeight() + 15, bottom: 20 });
        }
    },
    clear: function() {
        this.$log.empty();
        this.$prompt.text('');
        this.prompts = {};
        this.$tokens = null;
    },

    scrollDown: function() {
        this.$log.scrollTop(this.$log[0].scrollHeight);
    },
    note: function(text, cls) {
        $('<div class="llm_note">').addClass(cls).text(text).appendTo(this.$log);
        this.scrollDown();
    },
    showPrompt: function(prompt, n) {
        this.$prompt.text((n ? 'Prompt Schritt #' + n + ':\n' : '') + prompt);
    },
    percent: function(p) {
        return Math.round(p * 100) + '%';
    },

    /** Gibt den Log-Eintrag für Schritt n zurück und legt ihn bei Bedarf an. */
    entry: function(n) {
        var $entry = this.$log.children('[data-n="' + n + '"]');
        if (!$entry.length) {
            $entry = $('<div class="llm_entry"><div class="llm_think"></div><div class="llm_line"></div></div>')
                .attr('data-n', n).appendTo(this.$log);
            $entry.find('.llm_line').text('#' + n + ' …');
            var $all = this.$log.children();
            if ($all.length > this.MAX_ENTRIES) { $all.first().remove(); }
        }
        return $entry;
    },
    setLine: function(n, html, cls) {
        this.entry(n).addClass(cls || '').find('.llm_line').html(html);
        this.scrollDown();
    },

    /** Schreibt ein Event vom Server ins Log. */
    onEvent: function(ev) {
        switch (ev.type) {
        case 'start':
            var titles = { step: 'Schritt für Schritt …', bestfirst: 'LLM-Best-First …',
                           oneshot: 'One-Shot: ganze Karte als Text …' };
            this.note(titles[ev.mode], 'llm_head');
            break;
        case 'think':
            var $think = this.entry(ev.n).find('.llm_think');
            $think.show().text($think.text() + ev.text);
            this.scrollDown();
            break;
        case 'step':
            this.step(ev);
            break;
        case 'jump':
            this.setLine(ev.n, '#' + ev.n + ' ↩ Rücksprung zu (' + ev.to + ') – ' + ev.dir +
                         ' von (' + ev.via + '), ' + this.percent(ev.p) + ' = beste offene Option',
                         'llm_jump');
            break;
        case 'deadend':
            this.setLine(ev.n, '#' + ev.n + ' ✖ Sackgasse bei (' + ev.at + ')', 'llm_jump');
            break;
        case 'prompt':
            this.showPrompt(ev.prompt);
            break;
        case 'token':
            if (!this.$tokens) {
                this.note('LLM-Antwort:', 'llm_head');
                this.$tokens = $('<pre class="llm_tokens">').appendTo(this.$log);
            }
            this.$tokens.text(this.$tokens.text() + ev.text);
            this.scrollDown();
            break;
        }
    },

    /** Eine Zeile pro Schritt, z. B. "#12 (5,7) → right (6,7) 82% | up 10% | down 8%". */
    step: function(ev) {
        var self = this, chosen = ev.options[ev.chosen];
        var describe = function(o) {
            return o.dir + ' ' + self.percent(o.p) + (o.visited ? ' <i>(' + o.visited + 'x)</i>' : '');
        };
        var others = ev.options
            .filter(function(o, i) { return i !== ev.chosen; })
            .sort(function(a, b) { return b.p - a.p; })
            .map(describe);
        var html = '#' + ev.n + ' (' + ev.pos + ') → <b>' + chosen.dir + ' (' + chosen.to + ') ' +
                   this.percent(chosen.p) + '</b>' +
                   (chosen.visited ? ' <i>(' + chosen.visited + 'x)</i>' : '') +
                   (others.length ? ' | ' + others.join(' | ') : '') +
                   (ev.forced ? ' <i>(einzige Option, ohne LLM)</i>' : '');

        this.setLine(ev.n, html);
        this.entry(ev.n).toggleClass('llm_unsure', chosen.p < 0.6).toggleClass('llm_forced', !!ev.forced);
        if (ev.prompt) {
            this.prompts[ev.n] = ev.prompt;
            this.showPrompt(ev.prompt, ev.n);
        }
    },

    /** Schreibt die Ergebniszeilen am Ende des Laufs. */
    done: function(result) {
        var self = this;
        result.stats.lines.forEach(function(line) {
            self.note($('<span>').html(line).text(), 'llm_result');
        });
    },
    error: function(message) {
        this.note('Fehler: ' + message, 'llm_error');
    }
};
