$(document).ready(function() {
    $.ajax({
        url: "/do-auto-login",
        method: "GET",
        dataType: "json",
        processData: false,
        contentType: false,
        timeout: 100000,
    }).done(function(data, textStatus, jqXHR) {
        window.location.replace("/");
    });
});