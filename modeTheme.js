// license: https://www.w3schools.com/howto/howto_js_toggle_dark_mode.asp
function darkTheme() { 
   var element = document.body;
   element.classList.toggle("dark-mode");
   var button = document.querySelector("button")
   button.classList.add("dark-modeBtn")
}

function lightTheme() { 
   var body = document.querySelector("body")
   body.classList.remove("dark-mode")
   var button = document.querySelector("button")
   button.classList.remove("dark-modeBtn")
}
