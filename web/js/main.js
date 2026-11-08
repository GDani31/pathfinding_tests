$(document).ready(function() {
    if (!Raphael.svg) {
        window.location = './notsupported.html';
    }
    $(window).bind('selectstart', function(event) {
        event.preventDefault();
    });
    Panel.init();
    Controller.init();
});
