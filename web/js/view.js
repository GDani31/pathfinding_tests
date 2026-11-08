/**
 * Zeichnet das Raster mit Raphael (SVG).
 */
var View = {
    nodeSize: LLMConfig.size,
    nodeStyle: {
        normal:  { fill: 'white',   'stroke-opacity': 0.2 },
        blocked: { fill: 'grey',    'stroke-opacity': 0.2 },
        start:   { fill: '#0d0',    'stroke-opacity': 0.2 },
        end:     { fill: '#e40',    'stroke-opacity': 0.2 },
        opened:  { fill: '#98fb98', 'stroke-opacity': 0.2 },
        closed:  { fill: '#afeeee', 'stroke-opacity': 0.2 },
        failed:  { fill: '#ff8888', 'stroke-opacity': 0.2 },
        tested:  { fill: '#e5e5e5', 'stroke-opacity': 0.2 }
    },
    nodeColorizeEffect: { duration: 50 },
    nodeZoomEffect: { duration: 200, transform: 's1.2', transformBack: 's1.0' },
    pathStyle: { stroke: 'yellow', 'stroke-width': 3 },
    supportedOperations: ['opened', 'closed', 'tested'],

    /** @param {Object} opts  { numCols, numRows } */
    init: function(opts) {
        this.numCols = opts.numCols;
        this.numRows = opts.numRows;
        this.paper = Raphael('draw_area');
        this.$stats = $('#stats');
    },

    /**
     * Erzeugt die Felder Zeile für Zeile, damit der Browser nicht hängt.
     * @param {Function} callback  wird aufgerufen, wenn alles gezeichnet ist
     */
    generateGrid: function(callback) {
        var self = this, size = this.nodeSize, tasks = [];
        this.rects = [];
        this.paper.setSize(this.numCols * size, this.numRows * size);

        var drawRow = function(y) {
            return function(done) {
                self.rects[y] = [];
                for (var x = 0; x < self.numCols; ++x) {
                    self.rects[y].push(self.paper.rect(x * size, y * size, size, size)
                                                 .attr(self.nodeStyle.normal));
                }
                self.$stats.text('generating grid ' + Math.round((y + 1) / self.numRows * 100) + '%');
                setTimeout(function() { done(null); }, 0);
            };
        };
        for (var y = 0; y < this.numRows; ++y) {
            tasks.push(drawRow(y));
        }
        async.series(tasks, function() {
            if (callback) { callback(); }
        });
    },

    setStartPos: function(gridX, gridY) {
        this.startNode = this.moveMarker(this.startNode, gridX, gridY, this.nodeStyle.start);
    },
    setEndPos: function(gridX, gridY) {
        this.endNode = this.moveMarker(this.endNode, gridX, gridY, this.nodeStyle.end);
    },
    /**
     * Legt das Start-/Ziel-Feld an oder verschiebt es.
     * @return {Object} das Raphael-Element
     */
    moveMarker: function(node, gridX, gridY, style) {
        var coord = this.toPageCoordinate(gridX, gridY);
        if (!node) {
            return this.paper.rect(coord[0], coord[1], this.nodeSize, this.nodeSize)
                .attr(this.nodeStyle.normal)
                .animate(style, 1000);
        }
        return node.attr({ x: coord[0], y: coord[1] }).toFront();
    },

    /**
     * Färbt ein Feld je nach Operation ein.
     * @param {string} attr  'walkable', 'opened', 'closed' oder 'tested'
     */
    setAttributeAt: function(gridX, gridY, attr, value) {
        var rect = this.rects[gridY][gridX];
        switch (attr) {
        case 'walkable':
            this.setWalkableAt(gridX, gridY, value);
            return;
        case 'opened':
        case 'closed':
            this.colorizeNode(rect, this.nodeStyle[attr].fill);
            break;
        case 'tested':
            this.colorizeNode(rect, value ? this.nodeStyle.tested.fill : this.nodeStyle.normal.fill);
            break;
        default:
            return;
        }
        this.setCoordDirty(gridX, gridY, true);
    },
    colorizeNode: function(node, color) {
        node.animate({ fill: color }, this.nodeColorizeEffect.duration);
    },
    zoomNode: function(node) {
        node.toFront()
            .attr({ transform: this.nodeZoomEffect.transform })
            .animate({ transform: this.nodeZoomEffect.transformBack }, this.nodeZoomEffect.duration);
    },

    /** Zeichnet oder entfernt eine Wand (eine graue Kopie über dem Feld). */
    setWalkableAt: function(gridX, gridY, walkable) {
        if (!this.blockedNodes) {
            this.blockedNodes = [];
            for (var y = 0; y < this.numRows; ++y) { this.blockedNodes.push([]); }
        }
        var node = this.blockedNodes[gridY][gridX];
        if (walkable && node) {
            this.colorizeNode(node, this.rects[gridY][gridX].attr('fill'));
            this.zoomNode(node);
            setTimeout(function() { node.remove(); }, this.nodeZoomEffect.duration);
            this.blockedNodes[gridY][gridX] = null;
        } else if (!walkable && !node) {
            node = this.blockedNodes[gridY][gridX] = this.rects[gridY][gridX].clone();
            this.colorizeNode(node, this.nodeStyle.blocked.fill);
            this.zoomNode(node);
        }
    },
    /** Setzt alle eingefärbten Felder wieder auf weiß. */
    clearFootprints: function() {
        var self = this;
        this.getDirtyCoords().forEach(function(coord) {
            self.rects[coord[1]][coord[0]].attr(self.nodeStyle.normal);
            self.setCoordDirty(coord[0], coord[1], false);
        });
    },
    clearBlockedNodes: function() {
        if (!this.blockedNodes) { return; }
        this.blockedNodes.forEach(function(row) {
            row.forEach(function(node, x) {
                if (node) {
                    node.remove();
                    row[x] = null;
                }
            });
        });
    },

    /** Zeichnet den Weg als gelbe Linie. @param {Array} path  [[x, y], …] */
    drawPath: function(path) {
        if (!path.length) { return; }
        var size = this.nodeSize, half = size / 2;
        var svgPath = path.map(function(p, i) {
            return (i === 0 ? 'M' : 'L') + (p[0] * size + half) + ' ' + (p[1] * size + half);
        }).join('');
        this.path = this.paper.path(svgPath).attr(this.pathStyle);
    },
    clearPath: function() {
        if (this.path) { this.path.remove(); }
    },

    /**
     * Gelber Kreis an der Stelle, an der das LLM gerade ist.
     * @param {number} [view]  Sichtradius; > 0 zeichnet das Sichtfeld als Rahmen
     */
    setLLMPos: function(gridX, gridY, view) {
        var size = this.nodeSize,
            cx = gridX * size + size / 2,
            cy = gridY * size + size / 2;
        if (!this.llmMarker) {
            this.llmView = this.paper.rect(0, 0, 0, 0)
                .attr({ stroke: '#f80', 'stroke-width': 3, 'stroke-dasharray': '- ' });
            this.llmMarker = this.paper.circle(cx, cy, size * 0.28)
                .attr({ fill: '#ff0', stroke: '#333', 'stroke-width': 2 });
        }
        this.llmMarker.attr({ cx: cx, cy: cy }).toFront().show();
        if (view > 0) {
            this.llmView.attr({ x: (gridX - view) * size, y: (gridY - view) * size,
                                width: (2 * view + 1) * size, height: (2 * view + 1) * size })
                .toFront().show();
        } else {
            this.llmView.hide();
        }
    },
    clearLLMPos: function() {
        if (this.llmMarker) {
            this.llmMarker.hide();
            this.llmView.hide();
        }
    },

    /** @return {Array} [gridX, gridY] für eine Pixel-Position */
    toGridCoordinate: function(pageX, pageY) {
        return [Math.floor(pageX / this.nodeSize), Math.floor(pageY / this.nodeSize)];
    },
    /** @return {Array} [pageX, pageY] der linken oberen Ecke eines Felds */
    toPageCoordinate: function(gridX, gridY) {
        return [gridX * this.nodeSize, gridY * this.nodeSize];
    },

    /** Zeigt die Statistik unten links. @param {Object} opts  { pathLength, timeSpent, operationCount, llm } */
    showStats: function(opts) {
        var texts = opts.llm ? ['<b>LLM</b>'].concat(opts.llm.lines) : [
            'length: ' + Math.round(opts.pathLength * 100) / 100,
            'time: ' + opts.timeSpent + 'ms',
            'operations: ' + opts.operationCount
        ];
        $('#stats').show().html(texts.join('<br>'));
    },

    /** Merkt sich, welche Felder eingefärbt sind (zum späteren Zurücksetzen). */
    setCoordDirty: function(gridX, gridY, isDirty) {
        if (!this.coordDirty) {
            this.coordDirty = [];
            for (var y = 0; y < this.numRows; ++y) {
                this.coordDirty.push(new Array(this.numCols).fill(false));
            }
        }
        this.coordDirty[gridY][gridX] = isDirty;
    },
    /** @return {Array} alle eingefärbten Felder als [[x, y], …] */
    getDirtyCoords: function() {
        var coords = [];
        (this.coordDirty || []).forEach(function(row, y) {
            row.forEach(function(dirty, x) {
                if (dirty) { coords.push([x, y]); }
            });
        });
        return coords;
    }
};
