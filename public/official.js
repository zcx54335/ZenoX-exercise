const header = document.querySelector("[data-header]");
const menuButton = document.querySelector("[data-menu]");

function syncHeader() {
  header?.classList.toggle("is-scrolled", window.scrollY > 24);
}

menuButton?.addEventListener("click", () => {
  header?.classList.toggle("menu-open");
});

document.querySelectorAll(".site-nav a, .nav-actions a").forEach((link) => {
  link.addEventListener("click", () => header?.classList.remove("menu-open"));
});

syncHeader();
window.addEventListener("scroll", syncHeader, { passive: true });
