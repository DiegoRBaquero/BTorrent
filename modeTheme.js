// license: https://www.w3schools.com/howto/howto_js_toggle_dark_mode.asp
function darkModetheme() { 
   var element = document.body;
   element.classList.toggle("dark-mode");
   var btn1 = document.getElementById("btn1");
   element.classList.toggle("btn1DarkMode");
}
