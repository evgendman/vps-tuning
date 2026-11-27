# WireGuard на VPS: WG-Easy v15 и доступ к домашней сети

**Статус:** конфигурация WG-Easy v15.5.0 проверена на 2026-11-27; архитектура дополнительно воспроизведена на втором чистом VPS.

Документ описывает серверную архитектуру и эксплуатацию. Публичный IP, имя сайта, список клиентов, их имена и адреса намеренно не приводятся: эти сведения относятся к частной конфигурации, а не к инструкции по настройке VPS. В примерах внешнее имя обозначено как `<PUBLIC_HOST>`.

Практическая сквозная проверка второй установки подтвердила подключение домашнего маршрутизатора к VPS по WireGuard и доступ через Nginx HTTPS reverse proxy к Jellyfin и TorrServer. Остальные проксируемые приложения на этой установке отдельно не проверялись.

## 1. Архитектура

WireGuard работает непосредственно в сетевом пространстве имён хоста VPS. Контейнер WG-Easy управляет интерфейсом хоста `wg1`, а не создаёт отдельный Docker bridge:

~~~text
WireGuard-клиенты
       |
       | UDP/443
       v
Хост VPS: интерфейс wg1
       |
       +---- выход клиентов в Интернет через eth0
       |
       +---- маршрутизация к домашнему маршрутизатору
                    |
                    v
             Домашняя LAN и сервисы

Nginx на VPS --- HTTPS reverse proxy --- wg1 --- домашний маршрутизатор
       |
       +---- локальный upstream WG-Easy Web UI
~~~

Основные свойства схемы:

- WG-Easy v15.5.0 использует `network_mode: host`.
- WireGuard-интерфейс называется `wg1` и слушает UDP/443.
- Отдельный Docker bridge, port mapping для WireGuard и маршрут через IP контейнера не используются.
- Внутреннее адресное пространство WireGuard и параметры клиентов хранятся в локальной базе WG-Easy; их не следует публиковать.
- На VPS включена IPv4-маршрутизация.
- IPv6 для WG-Easy отключён; клиентские профили используют IPv4.

## 2. Docker Compose

Рабочий каталог: `/opt/edge-gateway`.

Файл: `/opt/edge-gateway/compose.yaml`.

Существенная часть текущей конфигурации:

~~~yaml
name: edge-gateway

services:
  edge-gateway:
    image: ghcr.io/wg-easy/wg-easy:15.5.0
    container_name: edge-gateway
    restart: unless-stopped
    network_mode: host

    environment:
      HOST: "127.0.0.1"
      PORT: "51822"
      INSECURE: "false"
      DISABLE_IPV6: "true"
      TRUSTED_PROXIES: "127.0.0.1"
      WG_INTERFACE: "wg1"

    volumes:
      - ./config:/etc/wireguard
      - /lib/modules:/lib/modules:ro

    cap_add:
      - NET_ADMIN
      - SYS_MODULE
~~~

Применение конфигурации выполняется из рабочего каталога:

~~~bash
cd /opt/edge-gateway
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps
~~~

### Где хранятся данные

- База WG-Easy: `/opt/edge-gateway/config/wg-easy.db`.
- Сгенерированный WireGuard-конфиг: `/opt/edge-gateway/config/wg1.conf`.
- Compose: `/opt/edge-gateway/compose.yaml`.

База SQLite содержит закрытые ключи клиентов и другие чувствительные данные. Файлы конфигурации имеют ограниченные права доступа. Не редактировать сгенерированный `wg1.conf` вручную: изменения интерфейса и клиентов следует выполнять через WG-Easy Admin Panel.

## 3. Параметры WireGuard и Web UI

### WireGuard

- Интерфейс: `wg1`.
- Транспортный порт сервера: UDP/443.
- Внешний endpoint в клиентском профиле имеет форму `<PUBLIC_HOST>:443`.
- Глобальный IPv4 Allowed IPs для full-tunnel профилей: `0.0.0.0/0`.
- IPv6 отключён; `::/0` в клиентские профили не добавляется.
- DNS по умолчанию задаётся в WG-Easy Admin Panel.
- Глобальное значение Persistent Keepalive по умолчанию для новых клиентских конфигураций — **25 секунд**. Оно применяется на стороне клиента и поддерживает NAT-состояние, когда инициирующее подключение находится за NAT (например, домашний маршрутизатор).
- Для отдельного пира значение можно переопределить в его настройках. Это параметр устойчивости NAT, а не средство маскировки WireGuard-трафика.

Не публиковать экспортированные клиентские конфиги, QR-коды, приватные ключи, preshared keys, резервные копии базы или список клиентов.

### Web UI

Web UI не слушает публичный интерфейс. Он доступен локально на `127.0.0.1:51822` и публикуется через Nginx по HTTPS на отдельном TCP-порту с дополнительной Basic Authentication.

Параметры `HOST`, `PORT`, `INSECURE` и `TRUSTED_PROXIES` в Compose должны оставаться согласованными с Nginx reverse proxy. Не выставлять внутренний порт UI непосредственно в Интернет.

## 4. Маршрутизация и NAT на хосте

Для маршрутизации IPv4 на VPS включён системный параметр:

~~~bash
sysctl net.ipv4.ip_forward
~~~

Ожидаемое значение — `1`.

WG-Easy создаёт штатные правила NAT для выхода VPN-клиентов в Интернет. Дополнительно Docker на хосте использует nftables и цепочку `ip filter DOCKER-USER`. Поскольку политика цепочки FORWARD может запрещать пересылку по умолчанию, отдельная host-side служба устанавливает три ограниченных правила.

| Комментарий правила | Направление | Действие | Назначение |
|---|---|---|---|
| `edge-gateway-wg1-peer-isolation` | `wg1 → wg1` | DROP | Изоляция клиентов друг от друга |
| `edge-gateway-wg1-return` | `eth0 → wg1` | ACCEPT | Ответный established/related трафик |
| `edge-gateway-wg1-egress` | `wg1 → eth0` | ACCEPT | Выход IPv4-клиентов в Интернет |

Правила ограничиваются адресным пространством WireGuard и указанными интерфейсами. Они не открывают произвольную пересылку между интерфейсами.

### Скрипт и systemd

- Скрипт: `/usr/local/sbin/edge-gateway-nft-rules`.
- Unit: `/etc/systemd/system/edge-gateway-nft-rules.service`.
- Служба включена в автозапуск.
- `ExecStart` применяет недостающие правила.
- `ExecStop` удаляет только правила с собственными комментариями.
- Повторный запуск идемпотентен: дубликаты не создаются.
- Скрипт ожидает появления цепочки Docker `DOCKER-USER` после запуска Docker.
- Unit связан с `docker.service` через `After=`, `Wants=` и `PartOf=`; после перезапуска Docker правила устанавливаются снова.

Проверка и ручное применение:

~~~bash
sudo systemctl is-enabled edge-gateway-nft-rules.service
sudo systemctl is-active edge-gateway-nft-rules.service
sudo systemctl status edge-gateway-nft-rules.service --no-pager
sudo nft -a list chain ip filter DOCKER-USER

# Идемпотентное повторное применение
sudo /usr/local/sbin/edge-gateway-nft-rules apply
~~~

Удалять правила вручную или заменять широкими ACCEPT-правилами не следует. Для штатного удаления управляемых правил используйте только:

~~~bash
sudo /usr/local/sbin/edge-gateway-nft-rules remove
~~~

## 5. Проверка WireGuard

Состояние контейнера и healthcheck:

~~~bash
docker inspect edge-gateway   --format '{{.Name}} {{.State.Status}} {{.State.Health.Status}}'
~~~

Порт интерфейса и состояние WireGuard:

~~~bash
docker exec edge-gateway wg show wg1 listen-port
docker exec edge-gateway wg show wg1
~~~

Ожидаемый порт — UDP/443. Вывод `wg show` содержит сведения о подключённых клиентах и сетевых параметрах; не прикладывать его целиком к публичным issue и не сохранять в публичном репозитории.

Проверка интерфейса и маршрута:

~~~bash
ip -brief address show wg1
ip -4 route
~~~

Проверка журналов:

~~~bash
docker logs --tail 100 edge-gateway
journalctl -u edge-gateway-nft-rules.service -b --no-pager
~~~

## 6. Поведение после перезапуска Docker

Перезапуск Docker кратковременно прерывает WireGuard и контейнерные приложения. После восстановления должны автоматически произойти следующие действия:

1. Docker запускает контейнер WG-Easy.
2. Контейнер восстанавливает интерфейс `wg1`.
3. systemd повторно применяет nftables-правила.
4. Клиентские WireGuard-сессии восстанавливаются после повторного handshake.

Проверять после перезапуска:

~~~bash
systemctl is-active docker
docker inspect edge-gateway --format '{{.State.Status}} {{.State.Health.Status}}'
docker exec edge-gateway wg show wg1 listen-port
systemctl is-active edge-gateway-nft-rules.service
nft -a list chain ip filter DOCKER-USER
~~~

В ходе приёмочной проверки перезапуск Docker был выполнен: интерфейс, контейнер, firewall-служба и опубликованные сервисы восстановились автоматически.

## 7. Windows-клиент и локальная сеть

При full-tunnel профиле Windows WireGuard может использовать опцию **Block untunneled traffic**. Это kill-switch, блокирующий не только обход VPN для Интернета, но и локальные подключения вне туннеля.

Если при активном VPN требуется сохранить прямой доступ к локальной сети пользователя, эту опцию следует отключить в свойствах соответствующего профиля Windows. Настройка относится только к клиенту и не изменяет серверные маршруты, другие профили или глобальный Allowed IPs WG-Easy.

## 8. Резервное копирование и секреты

Резервировать локально:

- SQLite-базу WG-Easy;
- сгенерированный интерфейсный конфиг;
- Compose-файл;
- Nginx-конфигурацию;
- nftables helper и systemd unit.

Резервные копии с ключами и клиентскими данными должны храниться только на VPS или в другом защищённом частном хранилище с ограниченными правами. Не загружать их в GitHub.

В публичную документацию допустимо включать архитектуру, версии ПО, имена интерфейсов, порты приложений, пути к unit-файлам и команды диагностики. Не включать публичный IP VPS, реальное имя сайта, список пиров, имена клиентов, адреса клиентов, приватные ключи, пароли, токены и содержимое клиентских конфигов.

