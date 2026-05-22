(function () {
    var MANIFEST_URL = '/image/home-covers/manifest.json';
    var FALLBACK_COVER = '/image/header/home.jpg';
    var SESSION_KEY = 'liveforcode.home.lastDoc';
    var REFRESH_INTERVAL = 5 * 60 * 1000;
    var manifest = null;
    var manifestVersion = '';
    var preloaded = {};

    function getPortal() {
        return document.querySelector('.home-portal');
    }

    function getState() {
        var portal = getPortal();
        if (!portal) return null;
        return {
            current: parseInt(portal.getAttribute('data-current-page'), 10) || 1,
            total: parseInt(portal.getAttribute('data-total-page'), 10) || 1,
            perPage: parseInt(portal.getAttribute('data-per-page'), 10) || 15
        };
    }

    function padSlot(value) {
        return String(value).padStart(2, '0');
    }

    function addVersion(url) {
        if (!url || !manifestVersion || url === FALLBACK_COVER) return url;
        return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(manifestVersion);
    }

    function defaultCover(page, slot) {
        return '/image/home-covers/page-' + page + '/' + padSlot(slot) + '.jpg';
    }

    function getPageCovers(page) {
        var state = getState();
        var perPage = state ? state.perPage : 15;
        var covers = [];
        var pageMap = manifest && manifest.pages ? manifest.pages : null;
        var pageCovers = pageMap && Array.isArray(pageMap[String(page)]) ? pageMap[String(page)] : [];

        for (var i = 0; i < perPage; i++) {
            covers.push(pageCovers[i] || defaultCover(page, i + 1));
        }

        return covers;
    }

    function setImage(card, image, rawUrl) {
        var url = addVersion(rawUrl);
        card.setAttribute('data-doc-cover', url);
        image.setAttribute('data-local-cover', rawUrl);
        image.removeAttribute('data-fallback-used');

        image.onerror = function () {
            if (image.getAttribute('data-fallback-used') === 'true') return;
            image.setAttribute('data-fallback-used', 'true');
            image.src = image.getAttribute('data-fallback') || FALLBACK_COVER;
            card.setAttribute('data-doc-cover', image.src);
        };

        image.src = url;
    }

    function applyCurrentPageCovers() {
        var state = getState();
        if (!state) return;

        var covers = getPageCovers(state.current);
        var cards = document.querySelectorAll('.home-doc-card');
        Array.prototype.forEach.call(cards, function (card, index) {
            var image = card.querySelector('.home-doc-image');
            var rawUrl = covers[index] || defaultCover(state.current, index + 1);
            card.setAttribute('data-cover-page', state.current);
            card.setAttribute('data-cover-slot', padSlot(index + 1));
            if (image) setImage(card, image, rawUrl);
        });
    }

    function preloadUrl(rawUrl) {
        var url = addVersion(rawUrl);
        if (!url || preloaded[url]) return;
        preloaded[url] = true;

        var link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = url;
        document.head.appendChild(link);

        var image = new Image();
        image.src = url;
    }

    function preloadPage(page) {
        var state = getState();
        if (!state || page < 1 || page > state.total) return;
        getPageCovers(page).forEach(preloadUrl);
    }

    function pageFromHref(href) {
        var link = document.createElement('a');
        link.href = href || '';
        var match = link.pathname.match(/\/page\/(\d+)\/?$/);
        return match ? parseInt(match[1], 10) : 1;
    }

    function bindPreloadTriggers() {
        var portal = getPortal();
        var state = getState();
        if (!portal || !state) return;

        preloadPage(state.current + 1);

        portal.addEventListener('mouseenter', function () {
            preloadPage(state.current + 1);
        });

        document.addEventListener('mouseover', function (event) {
            var target = event.target;
            var link = target && target.closest ? target.closest('.pagination a') : null;
            if (link) preloadPage(pageFromHref(link.getAttribute('href')));
        });

        document.addEventListener('touchstart', function (event) {
            var target = event.target;
            var link = target && target.closest ? target.closest('.pagination a') : null;
            if (link) preloadPage(pageFromHref(link.getAttribute('href')));
        }, {passive: true});
    }

    function normalizePath(url) {
        var link = document.createElement('a');
        link.href = url || location.pathname;
        return link.pathname.replace(/\/index\.html$/, '/');
    }

    function readItemFromCard(card) {
        return {
            title: card.getAttribute('data-doc-title') || document.title || 'Untitled',
            url: card.getAttribute('data-doc-url') || card.getAttribute('data-doc-path') || '/',
            path: normalizePath(card.getAttribute('data-doc-path') || card.getAttribute('data-doc-url')),
            date: card.getAttribute('data-doc-date') || '',
            cover: card.getAttribute('data-doc-cover') || FALLBACK_COVER
        };
    }

    function bindCardLinks() {
        var cards = document.querySelectorAll('.home-doc-card');
        Array.prototype.forEach.call(cards, function (card) {
            var links = card.querySelectorAll('.home-doc-link');
            Array.prototype.forEach.call(links, function (link) {
                link.addEventListener('click', function () {
                    try {
                        sessionStorage.setItem(SESSION_KEY, JSON.stringify(readItemFromCard(card)));
                    } catch (error) {
                    }
                });
            });
        });
    }

    function loadManifest() {
        return fetch(MANIFEST_URL + '?t=' + Date.now(), {cache: 'no-store'})
            .then(function (response) {
                if (!response.ok) throw new Error('home cover manifest missing');
                return response.json();
            })
            .then(function (data) {
                manifest = data && data.pages ? data : null;
                manifestVersion = manifest && manifest.updatedAt ? manifest.updatedAt : String(Date.now());
                applyCurrentPageCovers();
                var state = getState();
                if (state) preloadPage(state.current + 1);
            })
            .catch(function () {
                manifest = null;
                manifestVersion = '';
                applyCurrentPageCovers();
            });
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (!getPortal()) return;
        bindCardLinks();
        bindPreloadTriggers();
        loadManifest();
        window.setInterval(loadManifest, REFRESH_INTERVAL);
    });
})();
