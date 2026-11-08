/**
 * Steuert die Visualisierung als Zustandsautomat
 * (https://github.com/jakesgordon/javascript-state-machine).
 * on<event>: läuft beim Ereignis, on<zustand>: läuft beim Betreten des Zustands.
 */
var Controller = StateMachine.create({
    initial: 'none',
    events: [
        { name: 'init',      from: 'none',                                   to: 'ready' },
        { name: 'search',    from: 'starting',                               to: 'searching' },
        { name: 'pause',     from: 'searching',                              to: 'paused' },
        { name: 'finish',    from: 'searching',                              to: 'finished' },
        { name: 'resume',    from: 'paused',                                 to: 'searching' },
        { name: 'cancel',    from: 'paused',                                 to: 'ready' },
        { name: 'modify',    from: 'finished',                               to: 'modified' },
        { name: 'reset',     from: '*',                                      to: 'ready' },
        { name: 'clear',     from: ['finished', 'modified'],                 to: 'ready' },
        { name: 'start',     from: ['ready', 'modified', 'restarting'],      to: 'starting' },
        { name: 'restart',   from: ['searching', 'finished'],                to: 'restarting' },
        { name: 'dragStart', from: ['ready', 'finished'],                    to: 'draggingStart' },
        { name: 'dragEnd',   from: ['ready', 'finished'],                    to: 'draggingEnd' },
        { name: 'drawWall',  from: ['ready', 'finished'],                    to: 'drawingWall' },
        { name: 'eraseWall', from: ['ready', 'finished'],                    to: 'erasingWall' },
        { name: 'rest',      from: ['draggingStart', 'draggingEnd', 'drawingWall', 'erasingWall'],
                             to: 'ready' }
    ]
});

$.extend(Controller, {
    gridSize: [LLMConfig.cols, LLMConfig.rows],
    operationsPerSecond: 300,

    onleavenone: function() {
        var numCols = this.gridSize[0],
            numRows = this.gridSize[1];

        this.grid = new PF.Grid(numCols, numRows);
        View.init({ numCols: numCols, numRows: numRows });
        View.generateGrid(function() {
            Controller.setDefaultStartEndPos();
            Controller.bindEvents();
            Controller.transition();
        });
        this.$buttons = $('.control_button');
        this.hookPathFinding();
        return StateMachine.ASYNC;
    },
    ondrawWall: function(event, from, to, gridX, gridY) {
        this.setWalkableAt(gridX, gridY, false);
    },
    oneraseWall: function(event, from, to, gridX, gridY) {
        this.setWalkableAt(gridX, gridY, true);
    },
    onsearch: function(event, from, to) {
        var finder = Panel.getFinder(),
            grid = this.grid.clone(),
            timeStart = performance.now();

        if (finder.isAsync) {
            this.searchAsync(finder, grid, timeStart);
            return;
        }
        this.llmStats = null;
        this.operations = [];
        this.path = finder.findPath(this.startX, this.startY, this.endX, this.endY, grid);
        this.operationCount = this.operations.length;
        this.timeSpent = (performance.now() - timeStart).toFixed(4);
        this.loop();
    },

    /**
     * Startet die LLM-Suche auf dem Server und zeichnet jedes Event sofort.
     * @param {LLMFinder} finder
     * @param {PF.Grid} grid  Kopie des Rasters
     * @param {number} timeStart  Startzeit in ms
     */
    searchAsync: function(finder, grid, timeStart) {
        var self = this, opCount = 0;
        this.abortAsync();
        this.asyncFinder = finder;
        this.operations = [];
        this.llmStats = null;
        LLMLog.clear();
        LLMLog.show(true);
        LLMLog.status('LLM denkt nach …');
        View.setLLMPos(this.startX, this.startY, finder.opt.view);

        var complete = function(res) {
            if (!self.is('searching')) {   // pausiert: beim Fortsetzen abschließen
                self.asyncPending = function() { complete(res); };
                return;
            }
            self.asyncPending = null;
            self.asyncFinder = null;
            self.path = res.path;
            self.llmStats = res.stats;
            self.operationCount = opCount + res.operations.length;
            self.timeSpent = (performance.now() - timeStart).toFixed(0);
            View.clearLLMPos();
            if (res.operations.length) {   // One-Shot: Prüfung des Wegs abspielen
                self.operations = res.operations;
                self.loop(Math.max(LLMLog.delay() / 4, 1000 / self.operationsPerSecond));
            } else {
                self.finish();
            }
        };

        var onEvent = function(ev) {
            var at = ev.at || ev.to;
            LLMLog.onEvent(ev);
            (ev.ops || []).forEach(function(op) {
                View.setAttributeAt(op.x, op.y, op.attr, op.value);
            });
            opCount += (ev.ops || []).length;
            if (at) {
                View.setLLMPos(at[0], at[1], finder.opt.view);
                LLMLog.status('Schritt ' + ev.n);
            } else if (ev.type === 'token') {
                LLMLog.status('LLM schreibt …');
            }
        };

        var onDone = function(res) {
            LLMLog.status('');
            LLMLog.done(res);
            complete(res);
        };

        var onError = function(message) {
            LLMLog.status('Fehler: ' + message, true);
            LLMLog.error(message);
            complete({ operations: [], path: [], stats: { lines: ['Fehler: ' + message] } });
        };

        // Callbacks eines abgebrochenen Laufs ignorieren
        var ifCurrent = function(fn) {
            return function(arg) { if (finder === self.asyncFinder) { fn(arg); } };
        };
        finder.run(this.startX, this.startY, this.endX, this.endY, grid, {
            onEvent: ifCurrent(onEvent), onDone: ifCurrent(onDone), onError: ifCurrent(onError)
        });
    },
    abortAsync: function() {
        if (this.asyncFinder) {
            this.asyncFinder.abort();
            this.asyncFinder = null;
        }
        this.asyncPending = null;
        View.clearLLMPos();
    },

    onrestart: function() {
        this.abortAsync();
        // warten, bis laufende Farb-Animationen fertig sind
        setTimeout(function() {
            Controller.clearOperations();
            Controller.clearFootprints();
            Controller.start();
        }, View.nodeColorizeEffect.duration * 1.2);
    },
    onpause: function(event, from, to) {
        if (this.asyncFinder) {
            this.asyncFinder.pause();
        }
    },
    onresume: function(event, from, to) {
        if (this.asyncPending) {
            this.asyncPending();
        } else if (this.asyncFinder) {
            this.asyncFinder.resume();
        } else {
            this.loop(this.loopInterval);
        }
    },
    oncancel: function(event, from, to) {
        this.abortAsync();
        LLMLog.status('');
        this.clearOperations();
        this.clearFootprints();
    },
    onfinish: function(event, from, to) {
        View.showStats({
            pathLength: PF.Util.pathLength(this.path),
            timeSpent: this.timeSpent,
            operationCount: this.operationCount,
            llm: this.llmStats
        });
        View.drawPath(this.path);
    },
    onclear: function(event, from, to) {
        this.clearOperations();
        this.clearFootprints();
    },
    onreset: function(event, from, to) {
        this.abortAsync();
        setTimeout(function() {
            Controller.clearOperations();
            Controller.clearAll();
            Controller.buildNewGrid();
        }, View.nodeColorizeEffect.duration * 1.2);
    },

    onready: function() {
        Maze.setEnabled(true);
        this.setButtonStates(
            { id: 1, text: 'Start Search', enabled: true, callback: $.proxy(this.start, this) },
            { id: 2, text: 'Pause Search', enabled: false },
            { id: 3, text: 'Clear Walls', enabled: true, callback: $.proxy(this.reset, this) });
    },
    onstarting: function(event, from, to) {
        Maze.setEnabled(false);
        this.clearFootprints();
        this.setButtonStates({ id: 2, enabled: true });
        this.search();
    },
    onsearching: function() {
        this.setButtonStates(
            { id: 1, text: 'Restart Search', enabled: true, callback: $.proxy(this.restart, this) },
            { id: 2, text: 'Pause Search', enabled: true, callback: $.proxy(this.pause, this) });
    },
    onpaused: function() {
        this.setButtonStates(
            { id: 1, text: 'Resume Search', enabled: true, callback: $.proxy(this.resume, this) },
            { id: 2, text: 'Cancel Search', enabled: true, callback: $.proxy(this.cancel, this) });
    },
    onfinished: function() {
        Maze.setEnabled(true);
        this.setButtonStates(
            { id: 1, text: 'Restart Search', enabled: true, callback: $.proxy(this.restart, this) },
            { id: 2, text: 'Clear Path', enabled: true, callback: $.proxy(this.clear, this) });
    },
    onmodified: function() {
        Maze.setEnabled(true);
        this.setButtonStates(
            { id: 1, text: 'Start Search', enabled: true, callback: $.proxy(this.start, this) },
            { id: 2, text: 'Clear Path', enabled: true, callback: $.proxy(this.clear, this) });
    },

    /**
     * Ersetzt die Felder opened/closed/tested von PF.Node durch Setter, die jede
     * Änderung in this.operations aufzeichnen. So kann die Suche danach abgespielt werden.
     */
    hookPathFinding: function() {
        var recorded = function(attr) {
            return {
                get: function() { return this['_' + attr]; },
                set: function(value) {
                    this['_' + attr] = value;
                    Controller.operations.push({ x: this.x, y: this.y, attr: attr, value: value });
                }
            };
        };
        PF.Node.prototype = Object.defineProperties({}, {
            opened: recorded('opened'),
            closed: recorded('closed'),
            tested: recorded('tested')
        });
        this.operations = [];
    },
    bindEvents: function() {
        $('#draw_area').mousedown($.proxy(this.mousedown, this));
        $(window)
            .mousemove($.proxy(this.mousemove, this))
            .mouseup($.proxy(this.mouseup, this));
    },

    /**
     * Spielt this.operations nacheinander ab.
     * @param {number} [interval]  ms pro Operation
     */
    loop: function(interval) {
        interval = interval || 1000 / this.operationsPerSecond;
        this.loopInterval = interval;
        (function next() {
            if (!Controller.is('searching')) {
                return;
            }
            Controller.step();
            setTimeout(next, interval);
        })();
    },
    /** Zeichnet die nächste Operation, oder beendet die Suche, wenn keine mehr da ist. */
    step: function() {
        var op;
        do {
            if (!this.operations.length) {
                this.finish();
                return;
            }
            op = this.operations.shift();
        } while (View.supportedOperations.indexOf(op.attr) === -1);
        View.setAttributeAt(op.x, op.y, op.attr, op.value);
    },
    clearOperations: function() {
        this.operations = [];
    },
    clearFootprints: function() {
        View.clearFootprints();
        View.clearPath();
    },
    clearAll: function() {
        this.clearFootprints();
        View.clearBlockedNodes();
    },
    buildNewGrid: function() {
        this.grid = new PF.Grid(this.gridSize[0], this.gridSize[1]);
    },

    mousedown: function(event) {
        var coord = View.toGridCoordinate(event.pageX, event.pageY),
            x = coord[0], y = coord[1];

        if (this.can('dragStart') && this.isStartPos(x, y)) {
            this.dragStart();
        } else if (this.can('dragEnd') && this.isEndPos(x, y)) {
            this.dragEnd();
        } else if (this.can('drawWall') && this.grid.isWalkableAt(x, y)) {
            this.drawWall(x, y);
        } else if (this.can('eraseWall') && !this.grid.isWalkableAt(x, y)) {
            this.eraseWall(x, y);
        }
    },
    mousemove: function(event) {
        var coord = View.toGridCoordinate(event.pageX, event.pageY),
            x = coord[0], y = coord[1];

        if (this.isStartOrEndPos(x, y)) {
            return;
        }
        switch (this.current) {
        case 'draggingStart':
            if (this.grid.isWalkableAt(x, y)) { this.setStartPos(x, y); }
            break;
        case 'draggingEnd':
            if (this.grid.isWalkableAt(x, y)) { this.setEndPos(x, y); }
            break;
        case 'drawingWall':
            this.setWalkableAt(x, y, false);
            break;
        case 'erasingWall':
            this.setWalkableAt(x, y, true);
            break;
        }
    },
    mouseup: function(event) {
        if (Controller.can('rest')) {
            Controller.rest();
        }
    },

    /**
     * Setzt Text, Aktivierung und Klick-Funktion der drei Knöpfe.
     * @param {...Object} opts  je { id, text?, enabled?, callback? }
     */
    setButtonStates: function() {
        $.each(arguments, function(i, opt) {
            var $button = Controller.$buttons.eq(opt.id - 1);
            if (opt.text) {
                $button.text(opt.text);
            }
            if (opt.callback) {
                $button.unbind('click').click(opt.callback);
            }
            if (opt.enabled === true) {
                $button.removeAttr('disabled');
            } else if (opt.enabled === false) {
                $button.attr({ disabled: 'disabled' });
            }
        });
    },

    /** Start links, Ziel rechts in der mittleren Zeile, immer im Raster. */
    setDefaultStartEndPos: function() {
        var cols = this.gridSize[0], rows = this.gridSize[1],
            y = Math.floor(rows / 2),
            startX = Math.min(2, cols - 2),
            endX = Math.min(Math.max(startX + 1, cols - 3), cols - 1);

        this.setStartPos(startX, y);
        this.setEndPos(endX, y);
    },
    setStartPos: function(gridX, gridY) {
        this.startX = gridX;
        this.startY = gridY;
        View.setStartPos(gridX, gridY);
    },
    setEndPos: function(gridX, gridY) {
        this.endX = gridX;
        this.endY = gridY;
        View.setEndPos(gridX, gridY);
    },
    setWalkableAt: function(gridX, gridY, walkable) {
        this.grid.setWalkableAt(gridX, gridY, walkable);
        View.setAttributeAt(gridX, gridY, 'walkable', walkable);
    },
    isStartPos: function(gridX, gridY) {
        return gridX === this.startX && gridY === this.startY;
    },
    isEndPos: function(gridX, gridY) {
        return gridX === this.endX && gridY === this.endY;
    },
    isStartOrEndPos: function(gridX, gridY) {
        return this.isStartPos(gridX, gridY) || this.isEndPos(gridX, gridY);
    }
});
