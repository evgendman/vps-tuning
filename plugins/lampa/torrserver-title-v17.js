(function () {
    'use strict';

    var VERSION = 'v17';
    var LOG = '[TorrServer Title ' + VERSION + ']';

    var TIRAMISU_TORRENTS_PATH = '/tiramisu_torrents';
    var TIRAMISU_ADD_PATH = '/tiramisu_add';

    var serverHashes = Object.create(null);
    var renderedItems = [];
    var installed = false;
    var refreshInProgress = false;

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function asText(value) {
        return value == null ? '' : String(value);
    }

    function normalizeHash(value) {
        var hash = asText(value).trim().toLowerCase();
        return /^[a-f0-9]{40}$/.test(hash) ? hash : '';
    }

    function base32ToHex(base32) {
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        var bits = '';
        var clean = asText(base32).toUpperCase().replace(/[^A-Z2-7]/g, '');
        var output = '';
        var i;

        if (!clean) return '';

        for (i = 0; i < clean.length; i++) {
            var index = alphabet.indexOf(clean.charAt(i));
            if (index < 0) return '';

            bits += ('00000' + index.toString(2)).slice(-5);
        }

        for (i = 0; i + 8 <= bits.length; i += 8) {
            output += parseInt(bits.slice(i, i + 8), 2)
                .toString(16)
                .padStart(2, '0');
        }

        return normalizeHash(output);
    }

    function getInfoHash(element) {
        if (!element) return '';

        var sources = [
            element.MagnetUri,
            element.Link,
            element.link
        ];

        for (var i = 0; i < sources.length; i++) {
            var source = asText(sources[i]);

            if (!source) continue;

            var match =
                source.match(/btih:([a-zA-Z0-9]+)/i) ||
                source.match(/btih%3a([a-zA-Z0-9]+)/i);

            if (!match) continue;

            var raw = match[1];
            var hex = normalizeHash(raw);

            if (hex) return hex;

            if (/^[A-Z2-7]{32}$/i.test(raw)) {
                hex = base32ToHex(raw);

                if (hex) return hex;
            }
        }

        return '';
    }

    function postJson(url, payload, success, fail) {
        var data;

        try {
            data = JSON.stringify(payload);
        } catch (e) {
            if (fail) fail(e);
            return;
        }

        var request = new XMLHttpRequest();

        request.open('POST', url, true);
        request.setRequestHeader('Content-Type', 'application/json');

        request.onreadystatechange = function () {
            if (request.readyState !== 4) return;

            var ok = request.status >= 200 && request.status < 300;
            var result = null;

            if (request.responseText) {
                try {
                    result = JSON.parse(request.responseText);
                } catch (e) {
                    result = request.responseText;
                }
            }

            if (ok) {
                if (success) success(result, request);
            } else if (fail) {
                fail(
                    result ||
                    request.statusText ||
                    ('HTTP ' + request.status),
                    request
                );
            }
        };

        request.onerror = function () {
            if (fail) fail('network error', request);
        };

        request.send(data);
    }

    function postTorrServer(payload, success, fail) {
        if (
            !Lampa.Torserver ||
            typeof Lampa.Torserver.url !== 'function'
        ) {
            if (fail) fail('TorrServer URL is unavailable');
            return;
        }

        var base = Lampa.Torserver.url();

        if (!base) {
            if (fail) fail('TorrServer URL is empty');
            return;
        }

        postJson(
            base.replace(/\/$/, '') + '/torrents',
            payload,
            success,
            fail
        );
    }

    function postTiramisu(path, payload, success, fail) {
        postJson(path, payload, success, fail);
    }

    function normalizeTorrServerList(result) {
        var list = Array.isArray(result)
            ? result
            : (
                result &&
                Array.isArray(result.torrents)
                    ? result.torrents
                    : []
            );

        serverHashes = Object.create(null);

        list.forEach(function (item) {
            var hash = normalizeHash(
                item && (item.hash || item.Hash)
            );

            if (hash) {
                serverHashes[hash] = true;
            }
        });
    }

    function repaintRenderedItems() {
        renderedItems.forEach(function (entry) {
            if (!entry || !entry.item) return;

            var hash = entry.infoHash;
            var saved = !!hash && !!serverHashes[hash];

            entry.item.toggleClass(
                'torrserver-saved',
                saved
            );

            entry.saved = saved;

            if (entry.dubRu) {
                entry.item.find('.m-audio').each(function () {
                    var text = asText($(this).text());

                    var isRus =
                        /\bRUS\b/i.test(text) ||
                        /\bRU\b/i.test(text) ||
                        /рус/i.test(text);

                    var isDub =
                        /дубляж|дублирован|\bdub\b/i.test(text);

                    $(this).toggleClass(
                        'torrserver-rus-dub',
                        isRus && isDub
                    );
                });
            }
        });
    }

    function rememberRenderedItem(element, item) {
        var infoHash = getInfoHash(element);

        var entry = {
            element: element,
            item: item,
            infoHash: infoHash,
            saved: false,
            dubRu: true
        };

        renderedItems.push(entry);
        repaintRenderedItems();

        return entry;
    }

    function refreshServerList(reason) {
        if (refreshInProgress) return;

        refreshInProgress = true;

        postTorrServer(
            {
                action: 'list'
            },
            function (result) {
                normalizeTorrServerList(result);

                refreshInProgress = false;

                log(
                    'TorrServer list OK:',
                    Object.keys(serverHashes).length,
                    reason || ''
                );

                requestAnimationFrame(function () {
                    repaintRenderedItems();

                    requestAnimationFrame(
                        repaintRenderedItems
                    );
                });
            },
            function (error) {
                refreshInProgress = false;

                log(
                    'TorrServer list ERROR:',
                    error,
                    reason || ''
                );
            }
        );
    }

    function getCurrentMovie() {
        try {
            var active =
                Lampa.Activity &&
                Lampa.Activity.active
                    ? Lampa.Activity.active()
                    : null;

            if (!active || !active.component) {
                return null;
            }

            var componentName =
                typeof active.component === 'string'
                    ? active.component
                    : '';

            if (
                componentName &&
                componentName !== 'torrents'
            ) {
                return active.movie || null;
            }

            return active.movie || null;
        } catch (e) {
            return null;
        }
    }

    function getOriginalTitle(movie) {
        if (!movie) return '';

        return asText(
            movie.original_title ||
            movie.original_name ||
            movie.title ||
            movie.name
        ).trim();
    }

    function getMovieYear(movie) {
        if (!movie) return null;

        var value = movie.year;

        if (value == null || value === '') {
            value = asText(
                movie.release_date ||
                movie.first_air_date
            ).slice(0, 4);
        }

        var year = parseInt(value, 10);

        return isFinite(year) ? year : null;
    }

    function getFirstAirDate(movie) {
        if (!movie) return '';

        var value = asText(
            movie.first_air_date || ''
        ).trim();

        return /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? value
            : '';
    }

    function getImdbId(movie) {
        if (!movie) return '';

        return asText(
            movie.imdb_id ||
            movie.imdb ||
            movie.imdbid
        ).trim();
    }

    function isTvMovie(movie) {
        if (!movie) return false;

        return !!(
            movie.original_name ||
            movie.name ||
            movie.number_of_seasons ||
            movie.number_of_episodes
        );
    }

    function getSeasonFromElement(element) {
        if (!element) return null;

        if (
            element.general &&
            element.general.season != null
        ) {
            var parsedGeneral = parseInt(
                element.general.season,
                10
            );

            if (
                isFinite(parsedGeneral) &&
                parsedGeneral >= 0
            ) {
                return parsedGeneral;
            }
        }

        var title = asText(
            element.Title || element.title
        );

        var match =
            title.match(/\bS(\d{1,2})\b/i) ||
            title.match(
                /\bSeason\s*(\d{1,2})\b/i
            );

        if (match) {
            var parsed = parseInt(
                match[1],
                10
            );

            if (
                isFinite(parsed) &&
                parsed >= 0
            ) {
                return parsed;
            }
        }

        return null;
    }

    function getTvSeasonNumber(element) {
        if (!element) return null;

        var raw =
            element.general &&
            element.general.season != null
                ? asText(
                    element.general.season
                ).trim()
                : '';

        if (raw) {
            if (/^\d{1,2}$/.test(raw)) {
                var number = parseInt(raw, 10);

                return (
                    isFinite(number) &&
                    number >= 0
                )
                    ? number
                    : null;
            }

            /*
             * Диапазон сезонов, например 1-3,
             * не является одним сезоном.
             */
            if (
                /^\d{1,2}\s*-\s*\d{1,2}$/.test(raw)
            ) {
                return null;
            }
        }

        var title = getTorrentTitle(element);

        /*
         * S01-S03 / Season 1-3:
         * Tiramisu получает только один season.
         */
        if (
            /\bS(\d{1,2})\s*(?:-|–|—|to)\s*S?\d{1,2}\b/i.test(title) ||
            /\bSeason\s*\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}\b/i.test(title)
        ) {
            return null;
        }

        return getSeasonFromElement(element);
    }

    function isSingleEpisodeTorrent(element) {
        if (!element) return false;

        if (
            element.general &&
            element.general.episodes != null
        ) {
            var episodes = asText(
                element.general.episodes
            ).trim();

            /*
             * Один конкретный эпизод.
             */
            if (/^\d{1,3}$/.test(episodes)) {
                return true;
            }

            /*
             * Диапазон или список эпизодов —
             * это часть сезона и поддерживается.
             */
            if (
                /^\d{1,3}\s*(?:-|–|—|,|&)\s*\d{1,3}(?:\s*(?:,|&)\s*\d{1,3})*$/.test(
                    episodes
                )
            ) {
                return false;
            }
        }

        var title = getTorrentTitle(element);

        var episodeMatch =
            title.match(
                /\bS\d{1,2}E(\d{1,3})\b/ig
            );

        /*
         * S01E05 — один эпизод.
         *
         * S01E01-E06 — диапазон, поэтому
         * отдельным эпизодом не считается.
         */
        if (
            episodeMatch &&
            episodeMatch.length === 1 &&
            !/S\d{1,2}E\d{1,3}\s*(?:-|–|—|to)\s*E?\d{1,3}/i.test(
                title
            )
        ) {
            return true;
        }

        return false;
    }

    function validateTvTorrent(element, movie) {
        var firstAirDate =
            getFirstAirDate(movie);

        var season =
            getTvSeasonNumber(element);

        if (!firstAirDate) {
            return {
                ok: false,
                reason: 'missing first_air_date'
            };
        }

        if (season === null) {
            return {
                ok: false,
                reason:
                    'torrent does not contain exactly one season'
            };
        }

        if (isSingleEpisodeTorrent(element)) {
            return {
                ok: false,
                reason:
                    'single episode torrents are not supported'
            };
        }

        return {
            ok: true,
            first_air_date: firstAirDate,
            season: season
        };
    }

    function getTorrentTitle(element) {
        return asText(
            element &&
            (
                element.Title ||
                element.title
            )
        );
    }

    function sanitizeTorrentTitle(title) {
        return String(title || '')
            .replace(
                /\s*\[LAMPA\]\s*/gi,
                ' '
            )
            .replace(
                /[\/\\|:?%#"<\x3E]/g,
                '!'
            )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();
    }

    function makeTorrServerTitle(
        originalTitle,
        movie
    ) {
        var title =
            sanitizeTorrentTitle(
                originalTitle
            );

        if (
            movie &&
            movie.id != null &&
            movie.id !== ''
        ) {
            title +=
                ' [tmdbid-' +
                movie.id +
                ']';
        }

        return title ||
            (
                'Torrent [tmdbid-' +
                (
                    movie &&
                    movie.id != null
                        ? movie.id
                        : 'unknown'
                ) +
                ']'
            );
    }

    function restoreController(enabled) {
        try {
            if (
                enabled &&
                Lampa.Controller &&
                typeof Lampa.Controller.toggle ===
                    'function'
            ) {
                Lampa.Controller.toggle(enabled);
            }
        } catch (e) {}
    }

    function addToTiramisu(
        element,
        movie,
        enabled
    ) {
        if (!element || !movie) {
            log(
                'Tiramisu: missing torrent or movie'
            );

            restoreController(enabled);
            return;
        }

        var link =
            element.MagnetUri ||
            element.Link ||
            element.link;

        var originalTitle =
            getOriginalTitle(movie);

        var releaseTitle =
            getTorrentTitle(element);

        var imdb =
            getImdbId(movie);

        /*
         * Для TV сразу формируем отдельную
         * валидацию и отдельную структуру данных.
         */
        var tvValidation =
            isTvMovie(movie)
                ? validateTvTorrent(
                    element,
                    movie
                )
                : null;

        if (!link) {
            log(
                'Tiramisu: missing magnet/link'
            );

            restoreController(enabled);
            return;
        }

        if (!originalTitle) {
            log(
                'Tiramisu: missing original title'
            );

            restoreController(enabled);
            return;
        }

        /*
         * Отдельные эпизоды, отсутствие сезона,
         * диапазон сезонов или отсутствие
         * first_air_date — не отправляем.
         */
        if (
            tvValidation &&
            !tvValidation.ok
        ) {
            log(
                'Tiramisu TV ERROR: ' +
                tvValidation.reason
            );

            restoreController(enabled);
            return;
        }

        /*
         * STEP 1
         *
         * Регистрация magnet в GoStorm.
         */
        log(
            'Tiramisu step 1: ' +
            TIRAMISU_TORRENTS_PATH
        );

        postTiramisu(
            TIRAMISU_TORRENTS_PATH,
            {
                action: 'add',
                link: link,
                title: originalTitle,
                save_to_db: true
            },
            function (result) {
                var hash =
                    normalizeHash(
                        result &&
                        result.hash
                    );

                if (!hash) {
                    log(
                        'Tiramisu step 1 ERROR: no hash',
                        result
                    );

                    restoreController(enabled);
                    return;
                }

                log(
                    'Tiramisu step 1 OK:',
                    result
                );

                var payload;

                /*
                 * =====================================================
                 * TV
                 * =====================================================
                 *
                 * Здесь намеренно НЕТ:
                 *
                 * year
                 * episode
                 *
                 * season — именно Number.
                 */
                if (isTvMovie(movie)) {
                    payload = {
                        type: 'tv',
                        hash: hash,
                        title: originalTitle,
                        first_air_date:
                            tvValidation.first_air_date,
                        season:
                            tvValidation.season,
                        release_title:
                            releaseTitle
                    };

                    /*
                     * IMDb необязателен.
                     * Добавляем только если Lampa
                     * действительно его предоставляет.
                     */
                    if (imdb) {
                        payload.imdb = imdb;
                    }

                } else {

                    /*
                     * =================================================
                     * MOVIE
                     * =================================================
                     */

                    var year =
                        getMovieYear(movie);

                    if (year === null) {
                        log(
                            'Tiramisu movie ERROR: missing year'
                        );

                        restoreController(enabled);
                        return;
                    }

                    payload = {
                        type: 'movie',
                        hash: hash,
                        title: originalTitle,
                        year: year,
                        release_title:
                            releaseTitle
                    };

                    if (imdb) {
                        payload.imdb = imdb;
                    }
                }

                /*
                 * ВАЖНО:
                 * JSON.stringify() здесь сериализует
                 * season как JSON number, поскольку
                 * tvValidation.season получен через parseInt().
                 */
                log(
                    'Tiramisu step 2: ' +
                    TIRAMISU_ADD_PATH,
                    payload
                );

                postTiramisu(
                    TIRAMISU_ADD_PATH,
                    payload,
                    function (response) {
                        log(
                            'Tiramisu added:',
                            response
                        );

                        restoreController(
                            enabled
                        );
                    },
                    function (error) {
                        log(
                            'Tiramisu step 2 ERROR:',
                            error
                        );

                        restoreController(
                            enabled
                        );
                    }
                );
            },
            function (error) {
                log(
                    'Tiramisu step 1 ERROR:',
                    error
                );

                restoreController(enabled);
            }
        );
    }

    function addToTorrServer(
        element,
        item,
        enabled
    ) {
        var movie = getCurrentMovie();

        var link =
            element &&
            (
                element.MagnetUri ||
                element.Link ||
                element.link
            );

        if (
            !movie ||
            !link ||
            !Lampa.Torserver ||
            typeof Lampa.Torserver.url !==
                'function'
        ) {
            restoreController(enabled);
            return;
        }

        var title =
            makeTorrServerTitle(
                element.Title ||
                element.title,
                movie
            );

        var payload = {
            action: 'add',
            link: link,
            title: title,
            poster: movie.img,

            data: JSON.stringify({
                lampa: true,
                movie: movie
            }),

            save_to_db: true,

            category:
                isTvMovie(movie)
                    ? 'tv'
                    : 'movie'
        };

        postTorrServer(
            payload,
            function (result) {
                var hash =
                    normalizeHash(
                        result &&
                        result.hash
                    ) ||
                    getInfoHash(element);

                if (hash) {
                    serverHashes[hash] = true;
                }

                repaintRenderedItems();

                log(
                    'TorrServer added:',
                    result
                );

                restoreController(enabled);
            },
            function (error) {
                log(
                    'TorrServer add ERROR:',
                    error
                );

                restoreController(enabled);
            }
        );
    }

    function removeFromTorrServer(
        element,
        enabled
    ) {
        var hash =
            getInfoHash(element);

        if (
            !hash ||
            !Lampa.Torserver ||
            typeof Lampa.Torserver.url !==
                'function'
        ) {
            restoreController(enabled);
            return;
        }

        postTorrServer(
            {
                action: 'drop',
                hash: hash
            },
            function (result) {
                delete serverHashes[hash];

                repaintRenderedItems();

                log(
                    'TorrServer removed:',
                    result
                );

                restoreController(enabled);
            },
            function (error) {
                log(
                    'TorrServer remove ERROR:',
                    error
                );

                restoreController(enabled);
            }
        );
    }

    function onTorrentRender(event) {
        if (
            !event ||
            !event.element ||
            !event.item
        ) {
            return;
        }

        rememberRenderedItem(
            event.element,
            event.item
        );
    }

    function onTorrentLong(event) {
        if (
            !event ||
            !event.element ||
            !event.item ||
            !event.menu
        ) {
            return;
        }

        var movie =
            getCurrentMovie();

        if (!movie) return;

        var enabled = null;

        try {
            enabled =
                Lampa.Controller
                    .enabled()
                    .name;
        } catch (e) {}

        var infoHash =
            getInfoHash(event.element);

        var hasServer =
            !!infoHash &&
            !!serverHashes[infoHash];

        /*
         * TorrServer
         */
        event.menu.push({
            title:
                hasServer
                    ? 'Удалить с TorrServer'
                    : 'Добавить на TorrServer',

            onSelect: function () {
                if (hasServer) {
                    removeFromTorrServer(
                        event.element,
                        enabled
                    );
                } else {
                    addToTorrServer(
                        event.element,
                        event.item,
                        enabled
                    );
                }
            }
        });

        /*
         * Tiramisu
         */
        event.menu.push({
            title:
                'Добавить на Tiramisu',

            onSelect: function () {
                addToTiramisu(
                    event.element,
                    movie,
                    enabled
                );
            }
        });
    }

    function installMenuHandler() {
        if (
            !Lampa.Listener ||
            typeof Lampa.Listener.follow !==
                'function'
        ) {
            return;
        }

        Lampa.Listener.follow(
            'torrent',
            function (event) {
                if (!event) return;

                if (
                    event.type === 'render'
                ) {
                    onTorrentRender(event);

                } else if (
                    event.type === 'onlong'
                ) {
                    onTorrentLong(event);
                }
            }
        );

        Lampa.Listener.follow(
            'activity',
            function (event) {
                if (!event) return;

                var type = event.type;
                var active = null;

                try {
                    active =
                        Lampa.Activity &&
                        Lampa.Activity.active
                            ? Lampa.Activity.active()
                            : null;
                } catch (e) {}

                if (
                    type === 'start' ||
                    type === 'create'
                ) {
                    var component =
                        active &&
                        active.component;

                    if (
                        component ===
                            'torrents' ||
                        (
                            event.component &&
                            event.component ===
                                'torrents'
                        )
                    ) {
                        renderedItems = [];

                        refreshServerList(
                            'activity ' +
                            type
                        );
                    }
                }

                if (
                    type === 'destroy'
                ) {
                    renderedItems = [];
                }
            }
        );
    }

    function interceptHash() {
        if (
            !Lampa.Torserver ||
            typeof Lampa.Torserver.hash !==
                'function'
        ) {
            return false;
        }

        if (
            Lampa.Torserver.hash
                .__ourTitleInterceptorV17
        ) {
            return true;
        }

        var originalHash =
            Lampa.Torserver.hash;

        Lampa.Torserver.hash =
            function (
                object,
                success,
                fail
            ) {
                if (
                    !object ||
                    typeof object !==
                        'object'
                ) {
                    return originalHash.call(
                        this,
                        object,
                        success,
                        fail
                    );
                }

                var movie =
                    object.data &&
                    object.data.movie
                        ? object.data.movie
                        : getCurrentMovie();

                var originalTitle =
                    object.title;

                var patched = {};

                for (
                    var key in object
                ) {
                    if (
                        Object.prototype
                            .hasOwnProperty
                            .call(
                                object,
                                key
                            )
                    ) {
                        patched[key] =
                            object[key];
                    }
                }

                patched.title =
                    makeTorrServerTitle(
                        originalTitle,
                        movie
                    );

                return originalHash.call(
                    this,
                    patched,
                    success,
                    fail
                );
            };

        Lampa.Torserver.hash
            .__ourTitleInterceptorV17 = true;

        log(
            'installed hash interceptor'
        );

        return true;
    }

    function install() {
        if (installed) {
            return true;
        }

        if (
            !window.Lampa ||
            !Lampa.Torserver ||
            typeof Lampa.Torserver.hash !==
                'function' ||
            typeof Lampa.Torserver.url !==
                'function'
        ) {
            return false;
        }

        interceptHash();
        installMenuHandler();

        installed = true;

        refreshServerList('startup');

        log('installed');

        return true;
    }

    function waitForLampa() {
        var attempts = 0;

        var timer =
            setInterval(
                function () {
                    attempts++;

                    if (
                        install() ||
                        attempts >= 50
                    ) {
                        clearInterval(
                            timer
                        );
                    }
                },
                200
            );
    }

    function installStyles() {
        if (
            document.getElementById(
                'torrserver-title-v17-style'
            )
        ) {
            return;
        }

        var style =
            document.createElement(
                'style'
            );

        style.id =
            'torrserver-title-v17-style';

        style.textContent =
            '.torrent-item.torrserver-saved{' +
            'box-shadow:inset 0 0 0 3px #22c55e;' +
            'border-radius:4px;' +
            '}' +

            '.torrent-item .m-audio.torrserver-rus-dub{' +
            'color:#22c55e !important;' +
            'font-weight:600;' +
            '}';

        document.head.appendChild(
            style
        );
    }

    installStyles();
    waitForLampa();

})();
