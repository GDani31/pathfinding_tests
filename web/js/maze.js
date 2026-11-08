/**
 * Erzeugt Wände: ein Labyrinth (zufälliger Spannbaum) oder zufällige Wände.
 * Start (grün) und Ziel (rot) bleiben, wo sie sind, und sind immer verbunden.
 */
var Maze = {
    LOOPS: 0.1,          // Anteil zusätzlich geöffneter Wände im Labyrinth (Schleifen)
    WALL_DENSITY: 0.28,  // Anteil Wände bei "Zufällige Wände"

    init: function() {
        $('#button_maze').click(function() { Maze.apply(Maze.spanningTree()); });
        $('#button_random').click(function() { Maze.apply(Maze.randomWalls()); });
    },

    /** @param {boolean} enabled  Knöpfe an/aus (aus während einer Suche) */
    setEnabled: function(enabled) {
        $('.maze_button').prop('disabled', !enabled);
    },

    /** @return {Array} Raster [y][x] mit true = Wand, alles voller Wände */
    full: function() {
        var walls = [];
        for (var y = 0; y < Controller.gridSize[1]; ++y) {
            walls.push(new Array(Controller.gridSize[0]).fill(true));
        }
        return walls;
    },
    inside: function(x, y) {
        return x >= 0 && y >= 0 && x < Controller.gridSize[0] && y < Controller.gridSize[1];
    },

    /**
     * Labyrinth per randomisierter Tiefensuche: jedes zweite Feld ist ein "Raum",
     * dazwischen liegen Wände. Die Suche verbindet alle Räume zu einem Spannbaum,
     * also gibt es von jedem Raum zu jedem anderen genau einen Weg.
     * Danach werden ein paar Wände zusätzlich geöffnet, damit es mehrere Wege gibt.
     * @return {Array} Raster [y][x] mit true = Wand
     */
    spanningTree: function() {
        var walls = this.full(), self = this,
            start = [Controller.startX, Controller.startY],
            px = start[0] % 2, py = start[1] % 2,   // Räume liegen auf der Parität des Starts
            steps = [[0, -2], [2, 0], [0, 2], [-2, 0]],
            stack = [start];

        var isRoom = function(x, y) {
            return self.inside(x, y) && x % 2 === px && y % 2 === py;
        };

        walls[start[1]][start[0]] = false;
        while (stack.length) {
            var cur = stack[stack.length - 1];
            var next = this.shuffle(steps.slice()).map(function(d) {
                return [cur[0] + d[0], cur[1] + d[1]];
            }).filter(function(p) {
                return isRoom(p[0], p[1]) && walls[p[1]][p[0]];
            })[0];
            if (!next) {
                stack.pop();
                continue;
            }
            walls[(cur[1] + next[1]) / 2][(cur[0] + next[0]) / 2] = false;   // Wand dazwischen
            walls[next[1]][next[0]] = false;
            stack.push(next);
        }

        // Schleifen: Wände öffnen, die zwei Räume trennen
        for (var y = 0; y < walls.length; ++y) {
            for (var x = 0; x < walls[0].length; ++x) {
                var between = (isRoom(x - 1, y) && isRoom(x + 1, y)) || (isRoom(x, y - 1) && isRoom(x, y + 1));
                if (walls[y][x] && between && Math.random() < this.LOOPS) {
                    walls[y][x] = false;
                }
            }
        }

        this.connectEnd(walls, isRoom);
        return walls;
    },

    /** Liegt das Ziel auf einer Wand-Position, wird ein kurzer Gang zum nächsten Raum gegraben. */
    connectEnd: function(walls, isRoom) {
        var ex = Controller.endX, ey = Controller.endY, best = null;
        for (var dy = -1; dy <= 1; ++dy) {
            for (var dx = -1; dx <= 1; ++dx) {
                if (isRoom(ex + dx, ey + dy) && !best) { best = [ex + dx, ey + dy]; }
            }
        }
        walls[ey][ex] = false;
        if (best) {
            walls[ey][best[0]] = false;   // erst waagerecht, dann senkrecht
            walls[best[1]][best[0]] = false;
        }
    },

    /**
     * Zufällige Wände; wiederholt, bis es einen Weg vom Start zum Ziel gibt.
     * @return {Array} Raster [y][x] mit true = Wand
     */
    randomWalls: function() {
        for (var attempt = 0; attempt < 100; ++attempt) {
            var walls = this.full();
            for (var y = 0; y < walls.length; ++y) {
                for (var x = 0; x < walls[0].length; ++x) {
                    walls[y][x] = Math.random() < this.WALL_DENSITY;
                }
            }
            walls[Controller.startY][Controller.startX] = false;
            walls[Controller.endY][Controller.endX] = false;
            if (this.hasPath(walls)) { return walls; }
        }
        return this.full().map(function(row) { return row.fill(false); });
    },

    /** Breitensuche. @return {boolean} gibt es einen Weg vom Start zum Ziel? */
    hasPath: function(walls) {
        var todo = [[Controller.startX, Controller.startY]], seen = {}, self = this;
        seen[todo[0]] = true;
        while (todo.length) {
            var p = todo.shift();
            if (p[0] === Controller.endX && p[1] === Controller.endY) { return true; }
            [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function(d) {
                var n = [p[0] + d[0], p[1] + d[1]];
                if (self.inside(n[0], n[1]) && !walls[n[1]][n[0]] && !seen[n]) {
                    seen[n] = true;
                    todo.push(n);
                }
            });
        }
        return false;
    },

    /** Übernimmt das Raster in die Ansicht; ändert nur Felder, die anders sind. */
    apply: function(walls) {
        if (Controller.can('clear')) { Controller.clear(); }
        if (!Controller.is('ready')) { return; }
        for (var y = 0; y < walls.length; ++y) {
            for (var x = 0; x < walls[0].length; ++x) {
                if (Controller.grid.isWalkableAt(x, y) === walls[y][x]) {
                    Controller.setWalkableAt(x, y, !walls[y][x]);
                }
            }
        }
    },

    /** Mischt ein Array zufällig (Fisher-Yates). @return {Array} dasselbe Array */
    shuffle: function(list) {
        for (var i = list.length - 1; i > 0; --i) {
            var j = Math.floor(Math.random() * (i + 1)), tmp = list[i];
            list[i] = list[j];
            list[j] = tmp;
        }
        return list;
    }
};
