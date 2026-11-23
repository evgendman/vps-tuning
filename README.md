# vps-tuning

## Плагины

- [TorrServer Title v17 для Lampa](plugins/lampa/torrserver-title-v17.js) — плагин отображения состояния торрентов TorrServer, добавления/удаления раздач и отправки данных в Tiramisu.

## Документация

- [WireGuard на VPS: WG-Easy v15 и доступ к домашней сети](docs/vps-to-keenetic-via-wg-easy.md) — WG-Easy v15.5.0 в host network mode, интерфейс wg1, UDP/443, nftables-изоляция клиентов, автоприменение правил после перезапуска Docker и диагностика.
- [Первоначальная настройка подключения](docs/initial-connection-setup.md) — пошаговая установка чистого WG-Easy v15.5.0 на Ubuntu 26.04 LTS без переноса настроек и создания пиров.
- [Публикация домашних сервисов через HTTPS на VPS](docs/vps-media-services-https.md) — Nginx reverse proxy, таблица внешних и внутренних портов, Basic Auth, TLS и переадресация на домашнем маршрутизаторе.
- [Дорожная карта настройки старого VPS](docs/roadmap.md) — план защиты SSH с Fail2ban и nftables, совместимость с Docker/WireGuard, порядок внедрения, проверки и откат. План пока не применён.
- [Media Station X, Lampa, TorrServer и Jellyfin: маршрутизация, Origin и CORS](docs/media-services-origin-routing.md) — архитектура HTTP/HTTPS-входов MSX, same-origin прокси Lampa → локальный TorrServer, публичных путей плагинов и Jellyfin /Videos/, правила Basic Auth/CORS и план переноса на Дубль.

Публичная документация не содержит фактический публичный IP VPS, имя сайта, перечень WireGuard-пиров и адреса клиентов, а также ключи, пароли, токены и реальные резервные копии.
