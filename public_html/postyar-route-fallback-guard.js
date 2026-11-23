/* POSTYAR-ROUTE-FALLBACK-GUARD-20261020 */
(function () {
  'use strict';
  var path = window.location.pathname || '/';
  var normalized = path.replace(/\/+$/, '') || '/';
  if (normalized !== '/' && normalized.toLowerCase() !== '/index.html') {
    document.documentElement.classList.add('postyar-spa-route');
  }
})();
