# Публикация домашних сервисов через HTTPS на VPS

**Статус:** документирует проверенную конфигурацию Nginx и WG-Easy v15 на 2026-11-19.

Документ описывает серверную схему публикации веб-интерфейсов. Публичный IP VPS, фактическое имя сайта, адрес WireGuard-пира маршрутизатора и клиентские данные намеренно не приводятся. В шаблонах используются обозначения `<PUBLIC_HOST>` и `<KEENETIC_WG_ADDRESS>`.

## 1. Архитектура

Публикуются отдельные веб-интерфейсы приложений, а не вся домашняя LAN:

~~~text
Браузер
  |
  | HTTPS : внешний порт
  v
Nginx на VPS
  | TLS termination
  | Basic Auth для защищённых приложений
  v
Хостовый WireGuard-интерфейс wg1
  |
  v
Домашний маршрутизатор
  | переадресация TCP-порта
  v
Ubuntu-медиа-сервер
  |
  v
Приложение
~~~

WG-Easy v15.5.0 использует `network_mode: host`; интерфейс WireGuard `wg1` находится в сетевом пространстве имён хоста. Nginx обращается к маршрутизатору напрямую через этот интерфейс. Отдельный host route через Docker bridge и отдельная SNAT-служба для старой bridge-схемы не требуются.

## 2. Таблица сервисов и портов

Каждый сервис публикуется через отдельный HTTPS-порт Nginx. Nginx направляет запрос к соответствующему TCP-порту на стороне домашнего маршрутизатора; тот перенаправляет его на Ubuntu-медиа-сервер.

| Сервис | HTTPS-порт VPS | TCP-порт на маршрутизаторе | Порт приложения | Дополнительный Basic Auth |
|---|---:|---:|---:|---|
| Jellyfin | 8296 | 8096 | 8096 | Нет, собственная авторизация Jellyfin |
| Seerr | 8255 | 5055 | 5055 | Да |
| TorrServer | 8292 | 8092 | 8092 | Да |
| Prowlarr | 8696 | 9696 | 9696 | Да |
| Radarr 1080p | 8278 | 7878 | 7878 | Да |
| Sonarr 1080p | 8288 | 8989 | 8989 | Да |
| Radarr 4K | 8279 | 7879 | 7879 | Да |
| Sonarr 4K | 8289 | 8988 | 8988 | Да |

TCP/443 используется Nginx для каталога сервисов. WireGuard использует UDP/443; совпадение номера порта не является конфликтом, поскольку транспортные протоколы разные.

## 3. Переадресация на домашнем маршрутизаторе

Для каждой строки таблицы создаётся отдельное правило переадресации:

- источник — WireGuard-интерфейс;
- входящий порт — значение из столбца «TCP-порт на маршрутизаторе»;
- протокол — TCP;
- адрес назначения — постоянный LAN-IP Ubuntu-медиа-сервера;
- порт назначения — значение из столбца «Порт приложения».

Назначение LAN-IP следует закрепить DHCP-резервированием. При изменении адреса медиа-сервера нужно скорректировать правила переадресации.

Не следует публиковать те же порты приложений напрямую через WAN-интерфейс маршрутизатора. Доступ к ним должен идти через WireGuard и Nginx на VPS.

## 4. Nginx

Основные файлы:

- сервисные virtual hosts: `/etc/nginx/sites-available/edge-services`;
- Web UI WG-Easy: `/etc/nginx/sites-available/wgeasy`;
- HTTP-01 challenge и перенаправление HTTP → HTTPS: `/etc/nginx/sites-available/riverhome-acme`;
- каталог сервисов: `/var/www/edge-gateway/index.html`;
- файл Basic Auth: `/etc/nginx/.htpasswd`.

Для Seerr, TorrServer, Prowlarr, Radarr и Sonarr включена дополнительная HTTP Basic Authentication. Jellyfin исключён из неё, поскольку использует собственную авторизацию приложения. Каталог сервисов и административный Web UI WG-Easy также защищены Basic Auth.

Административный Web UI WG-Easy v15 доступен через HTTPS на отдельном порту 8080 и проксируется Nginx на локальный upstream `127.0.0.1:51822`. Внутренний порт UI не должен быть доступен извне напрямую.

HTTP-порт 80 используется только для ACME HTTP-01 challenge и перенаправления остальных запросов на HTTPS. Сертификат Let's Encrypt устанавливается для фактического имени сайта на сервере; в публичных примерах его значение заменяется на `<PUBLIC_HOST>`.

### Пример server block

~~~nginx
server {
    listen 8296 ssl;
    server_name <PUBLIC_HOST>;

    ssl_certificate     /etc/letsencrypt/live/<PUBLIC_HOST>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<PUBLIC_HOST>/privkey.pem;

    location / {
        proxy_pass http://<KEENETIC_WG_ADDRESS>:8096;
        proxy_http_version 1.1;

        proxy_set_header Host              $http_host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Port  $server_port;
        proxy_set_header X-Forwarded-Proto https;
        proxy_redirect http://$http_host/ https://$http_host/;
    }
}
~~~

Для защищённых приложений в соответствующий server block добавляются:

~~~nginx
auth_basic "Application";
auth_basic_user_file /etc/nginx/.htpasswd;
~~~

Nginx передаёт исходный Host с нестандартным портом и внешний HTTPS-протокол. Это предотвращает формирование приложением неверных абсолютных ссылок и перенаправлений на стандартный порт.

Перед применением изменений:

~~~bash
sudo nginx -t
~~~

Только при успешной проверке:

~~~bash
sudo systemctl reload nginx
~~~

Автоматическое продление сертификата выполняется Certbot; deploy hook перезагружает Nginx после обновления сертификата.

## 5. Каталог и защита Web UI

Каталог опубликованных сервисов размещён в `/var/www/edge-gateway` и обслуживается Nginx на TCP/443 с Basic Auth.

Web UI WG-Easy проксируется только на loopback listener. В Compose используются:

- `HOST=127.0.0.1`;
- `PORT=51822`;
- `INSECURE=false`;
- `TRUSTED_PROXIES=127.0.0.1`.

Снаружи используется HTTPS и отдельная Basic Authentication. Файл `.htpasswd`, пароли и TLS private key не должны попадать в репозиторий.

## 6. Проверка всей цепочки

Проверка локального upstream с VPS:

~~~bash
curl -I http://<KEENETIC_WG_ADDRESS>:8096/
curl -I http://<KEENETIC_WG_ADDRESS>:5055/
curl -I http://<KEENETIC_WG_ADDRESS>:8092/
~~~

Проверка интерфейса WireGuard и firewall-службы:

~~~bash
docker exec edge-gateway wg show wg1 listen-port
systemctl is-active edge-gateway-nft-rules.service
sudo nft list chain ip filter DOCKER-USER
~~~

Проверка Nginx:

~~~bash
sudo nginx -t
sudo systemctl is-active nginx
~~~

Ожидаемое поведение без Basic Auth:

- защищённые сервисные порты возвращают HTTP 401;
- Jellyfin отвечает своим штатным HTTP redirect/login flow;
- каталог и административный Web UI также требуют Basic Auth.

HTTP 401 на защищённых портах без авторизации — ожидаемое поведение, а не признак недоступности upstream. Для проверки полной цепочки необходимо также выполнить вход и убедиться, что приложение корректно работает за reverse proxy.

Все восемь сервисных upstream-портов проверены после перехода WG-Easy на host networking и WireGuard UDP/443.

## 7. Что не следует публиковать

Не коммитить:

- публичный IP VPS и реальное имя сайта;
- фактический адрес WireGuard-пира маршрутизатора;
- список пиров, имена клиентов и их адреса;
- конфигурации WireGuard, ключи и QR-коды;
- `.htpasswd`, пароли и токены;
- приватный TLS-ключ;
- резервные копии WG-Easy SQLite/JSON и реальные серверные конфиги.

В публичном документе достаточно схемы, ролей узлов, портов сервисов, путей к системным файлам и шаблонов с заменителями чувствительных значений.

