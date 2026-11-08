/**
 * Rechte Spalte: Algorithmus-Auswahl, Play-Panel und LLM-Log.
 */
var Panel = {
    init: function() {
        var $algo = $('#algorithm_panel');

        $('.panel').draggable();
        $('.accordion').accordion({ collapsible: false, autoHeight: false });
        $('.option_label').click(function() {
            $(this).prev().click();
        });
        $('#hide_instructions').click(function() {
            $('#instructions_panel').slideUp();
        });
        $('#button2').attr('disabled', 'disabled');
        LLMLog.init();

        var updateLayout = function() {
            $('#play_panel').css({ top: $algo.offset().top + $algo.outerHeight() + 20 });
            LLMLog.show($('#llm_header').attr('aria-selected') === 'true');
        };
        $('.accordion').bind('accordionchange', updateLayout);
        $(window).resize(updateLayout);
        updateLayout();
    },

    /**
     * Baut den Finder für den gewählten Algorithmus mit seinen Optionen.
     * @return {Object} ein PathFinding.js-Finder oder ein LLMFinder
     */
    getFinder: function() {
        var name = $('#algorithm_panel .ui-accordion-header[aria-selected=true]')
                .attr('id').replace('_header', ''),
            $section = $('#' + name + '_section');

        var checked = function(cls) {
            return $section.find('.' + cls).is(':checked');
        };
        var number = function(inputName, fallback) {
            var value = parseFloat($section.find('input[name=' + inputName + ']').val());
            return isNaN(value) ? fallback : value;
        };
        var basic = {
            allowDiagonal: checked('allow_diagonal'),
            dontCrossCorners: checked('dont_cross_corners')
        };
        var withHeuristic = $.extend({}, basic, {
            heuristic: PF.Heuristic[$('input[name=' + name + '_heuristic]:checked').val()],
            weight: Math.max(1, Math.floor(number('astar_weight', 1)))
        });
        var bi = checked('bi-directional');

        switch (name) {
        case 'astar':
            return bi ? new PF.BiAStarFinder(withHeuristic) : new PF.AStarFinder(withHeuristic);
        case 'breadthfirst':
            return bi ? new PF.BiBreadthFirstFinder(basic) : new PF.BreadthFirstFinder(basic);
        case 'bestfirst':
            return bi ? new PF.BiBestFirstFinder(withHeuristic) : new PF.BestFirstFinder(withHeuristic);
        case 'dijkstra':
            return bi ? new PF.BiDijkstraFinder(basic) : new PF.DijkstraFinder(basic);
        case 'ida':
            var seconds = number('time_limit', -1);
            return new PF.IDAStarFinder($.extend(withHeuristic, {
                trackRecursion: checked('track_recursion'),
                timeLimit: seconds > 0 ? seconds : -1   // -1 = ohne Zeitlimit
            }));
        case 'jump_point':
        case 'orth_jump_point':
            var diagonal = PF.DiagonalMovement || {};   // fehlt in der mitgelieferten PF-Version
            return new PF.JumpPointFinder({
                trackJumpRecursion: checked('track_recursion'),
                heuristic: withHeuristic.heuristic,
                diagonalMovement: name === 'jump_point' ? diagonal.IfAtMostOneObstacle : diagonal.Never
            });
        case 'llm':
            return new LLMFinder({
                mode: $('input[name=llm_mode]:checked').val(),
                memory: checked('llm_memory'),
                thinking: checked('llm_thinking'),
                temperature: number('llm_temperature', 0),
                maxSteps: Math.floor(number('llm_max_steps', 300)) || 300
            });
        }
    }
};
