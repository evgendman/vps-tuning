# Первоначальная настройка подключения

**Назначение:** пошаговая установка чистого WG-Easy на новый VPS с Ubuntu 26.04 LTS по схеме, используемой на Дубле.

**Целевая конфигурация:** WG-Easy v15.5.0, Docker host network, интерфейс wg1, WireGuard UDP/443, Web UI на loopback и публикация панели через Nginx HTTPS/TCP 8080 + Basic Auth.

Инструкция рассчитана на VPS, на котором до начала работы установлена только ОС. Она не переносит базу WG-Easy, ключи, настройки или клиентские профили с другого сервера и **не создаёт ни одного пира**.

## 1. Что получится в результате

| Компонент | Настройка |
|---|---|
| Compose project / сервис / контейнер | edge-gateway |
| Образ | ghcr.io/wg-easy/wg-easy:15.5.0 |
| Сеть контейнера | host |
| WireGuard-интерфейс | wg1 |
| Порт WireGuard | UDP/443 |
| Web UI внутри VPS | 127.0.0.1:51822 |
| Публичная панель | HTTPS/TCP 8080 через Nginx |
| Дополнительная защита панели | HTTP Basic Authentication |
| IPv6 в WG-Easy | отключён |
| Изоляция пиров | wg1 → wg1 DROP в Docker-USER |
| Выход VPN-клиентов в Интернет | wg1 → внешний интерфейс VPS; ответный established/related трафик разрешён |
| Данные WG-Easy | /opt/edge-gateway/config |

Публичный IP, домен, адресный пул VPN, логин и пароли в этом документе не задаются. Их вводят непосредственно на новом VPS.

### Что нужно подготовить до начала

1. Чистый VPS с Ubuntu 26.04 LTS и доступом по SSH через пользователя с sudo.
2. Публичный IPv4-адрес VPS.
3. Доменное имя или отдельное поддоменное имя для панели. Его DNS A-запись должна указывать на публичный IP нового VPS.
4. Доступ к настройкам сетевого экрана у хостинг-провайдера.

На сетевом экране провайдера установите входящую политику **запрещать всё, кроме явно разрешённых правил**. Разрешите:

| Протокол | Порт | Назначение |
|---|---:|---|
| TCP | 22 | SSH; если SSH работает на другом порту, открыть именно его |
| TCP | 80 | получение и проверка сертификата Let's Encrypt |
| TCP | 8080 | защищённая веб-панель WG-Easy |
| UDP | 443 | WireGuard после завершения первоначальной настройки |

**Не разрешайте UDP/51820.** При первом запуске WG-Easy v15.5.0 автоматически поднимает временный интерфейс со стандартным портом UDP/51820 ещё до прохождения мастера. Позже в панели он будет переведён на UDP/443. Поэтому важно, чтобы входящий экран провайдера действительно блокировал все порты, кроме перечисленных выше, а не просто добавлял разрешающие правила к политике «разрешить всё».

**Не открывать TCP/51822:** этот порт должен оставаться доступным только локально на самом VPS. TCP/443 для данной конфигурации не требуется: WireGuard использует UDP/443. Если на VPS впоследствии появятся другие HTTPS-сайты, TCP/443 настраивается отдельно.

Для получения сертификата DNS A-запись домена уже должна разрешаться в новый VPS, а входящий TCP/80 должен быть доступен из Интернета. Если домен ещё не подготовлен, сначала выполните DNS-настройку.

Не включайте UFW вслепую. Docker управляет собственными правилами фильтрации; в этой конфигурации правила изоляции добавляются в созданную Docker цепочку DOCKER-USER. Предпочтительно использовать сетевой экран провайдера. Если UFW уже активен, до продолжения отдельно проверьте, что он разрешает SSH, TCP/80, TCP/8080 и UDP/443.

---

## Этап 1. Проверка чистой системы

Выполнять в SSH-сеансе от пользователя с правами sudo. Блок проверяет ОС, архитектуру, наличие sudo и маршрут наружу. Он ничего не меняет.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 1, код $rc, строка $LINENO" >&2' ERR

source /etc/os-release

if [[ "$EUID" -eq 0 ]]; then
    echo "[ОШИБКА] Запустите блок от обычного пользователя с sudo, не из root-shell." >&2
    exit 1
fi

if [[ "$ID" != "ubuntu" || "$VERSION_ID" != "26.04" ]]; then
    echo "[ОШИБКА] Требуется Ubuntu 26.04 LTS. Обнаружено: $PRETTY_NAME" >&2
    exit 1
fi

if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
    echo "[ОШИБКА] Эта инструкция рассчитана на VPS архитектуры amd64." >&2
    exit 1
fi

sudo -v
echo
echo "ОС: $PRETTY_NAME"
echo "Архитектура: $(dpkg --print-architecture)"
echo "Маршрут по умолчанию:"
ip -4 route show default
echo
echo "Состояние UFW:"
sudo ufw status verbose 2>/dev/null || true

echo "[УСПЕХ] Этап 1: система подходит для установки."
~~~

Если проверка завершилась ошибкой, дальше не переходить.

## Этап 2. Обновление ОС и установка системных пакетов

Устанавливаются инструменты диагностики, WireGuard, nftables/iptables, Nginx, Certbot и утилита для создания файла Basic Auth.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 2, код $rc, строка $LINENO" >&2' ERR

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y

sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    iproute2 \
    iptables \
    nftables \
    wireguard-tools \
    kmod \
    nginx \
    certbot \
    apache2-utils \
    openssl \
    python3 \
    bind9-dnsutils

sudo systemctl enable --now nginx

if [[ -f /var/run/reboot-required ]]; then
    echo "[ВНИМАНИЕ] После обновления ОС требуется перезагрузка:"
    cat /var/run/reboot-required.pkgs 2>/dev/null || true
    echo "[УСПЕХ] Этап 2: пакеты установлены; перед продолжением перезагрузите VPS."
    echo "Перезагрузите VPS командой: sudo reboot"
    echo "После повторного подключения продолжите с этапа 3."
    exit 0
fi

echo
echo "Версия Nginx:"
nginx -v
echo "Версия iptables:"
iptables --version
echo "Версия WireGuard tools:"
wg --version
echo "[УСПЕХ] Этап 2: пакеты установлены, Nginx запущен."
~~~

Ожидается, что iptables использует backend nf_tables (в выводе iptables --version должна присутствовать строка nf_tables). Если указан legacy backend, не продолжать: сначала нужно разобраться с альтернативами iptables на этом VPS.

Если при обновлении ядра был установлен новый kernel, после завершения этапа перезагрузите VPS и продолжите со следующего этапа.

## Этап 3. Установка Docker Engine из официального репозитория

Устанавливается Docker Engine вместе с Compose Plugin. Версия Docker не фиксируется вручную: используется актуальный пакет официального репозитория Docker для Ubuntu 26.04.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 3, код $rc, строка $LINENO" >&2' ERR

source /etc/os-release
UBUNTU_SUITE="${UBUNTU_CODENAME:-$VERSION_CODENAME}"

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $UBUNTU_SUITE
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

sudo systemctl enable --now docker

sudo docker run --rm hello-world
sudo docker compose version
sudo systemctl is-active --quiet docker

echo "[УСПЕХ] Этап 3: Docker Engine и Docker Compose установлены; Docker активен."
~~~

## Этап 4. Подготовка ядра, маршрутизации и определение внешнего интерфейса

Включается IPv4 forwarding, необходимый для передачи трафика VPN-клиентов через VPS. Модуль WireGuard загружается сейчас и при последующих загрузках ОС.

Внешний интерфейс определяется автоматически по маршруту до Интернета. Это важно: на разных VPS он может называться не eth0, а, например, ens3 или enp1s0.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 4, код $rc, строка $LINENO" >&2' ERR

sudo modprobe wireguard

echo wireguard | sudo tee /etc/modules-load.d/edge-gateway.conf >/dev/null

sudo tee /etc/sysctl.d/99-edge-gateway.conf >/dev/null <<'EOF'
net.ipv4.ip_forward=1
EOF

sudo sysctl --load=/etc/sysctl.d/99-edge-gateway.conf

if [[ "$(sysctl -n net.ipv4.ip_forward)" != "1" ]]; then
    echo "[ОШИБКА] IPv4 forwarding не включился." >&2
    exit 1
fi

WAN_IFACE="$(ip -4 route show default | awk 'NR == 1 {for (i=1; i<=NF; i++) if ($i=="dev") {print $(i+1); exit}}' )"

if [[ -z "$WAN_IFACE" || ! -d "/sys/class/net/$WAN_IFACE" ]]; then
    echo "[ОШИБКА] Не удалось определить внешний сетевой интерфейс VPS." >&2
    exit 1
fi

printf 'WAN_IFACE=%s\n' "$WAN_IFACE" | sudo tee /etc/default/edge-gateway-nft-rules >/dev/null
sudo chmod 644 /etc/default/edge-gateway-nft-rules

echo "WireGuard kernel module: загружен"
echo "IPv4 forwarding: $(sysctl -n net.ipv4.ip_forward)"
echo "Внешний интерфейс VPS: $WAN_IFACE"
echo "[УСПЕХ] Этап 4: ядро и маршрутизация подготовлены."
~~~

Запишите название внешнего интерфейса, выведенное в конце. Оно будет использовано при проверке настройки панели. В дальнейшем не подставляйте eth0 автоматически — ориентируйтесь на определённое системой значение.

## Этап 5. Создание и запуск WG-Easy

Создаётся каталог /opt/edge-gateway. В Compose намеренно не указываются публичный IP и VPN-адреса: публичный адрес будет задан в мастере первоначальной настройки WG-Easy.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 5, код $rc, строка $LINENO" >&2' ERR

sudo install -d -o root -g root -m 0750 /opt/edge-gateway
sudo install -d -o root -g root -m 0700 /opt/edge-gateway/config

sudo tee /opt/edge-gateway/compose.yaml >/dev/null <<'EOF'
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
EOF

sudo chmod 640 /opt/edge-gateway/compose.yaml

sudo docker compose --project-directory /opt/edge-gateway \
    -f /opt/edge-gateway/compose.yaml config --quiet
sudo docker compose --project-directory /opt/edge-gateway \
    -f /opt/edge-gateway/compose.yaml pull
sudo docker compose --project-directory /opt/edge-gateway \
    -f /opt/edge-gateway/compose.yaml up -d

CONTAINER_STATE="$(sudo docker inspect edge-gateway --format '{{.State.Status}}')"

if [[ "$CONTAINER_STATE" != "running" ]]; then
    sudo docker logs --tail 100 edge-gateway
    echo "[ОШИБКА] Контейнер edge-gateway не находится в состоянии running." >&2
    exit 1
fi

UI_READY=0
for attempt in $(seq 1 60); do
    if sudo ss -lntp | grep -q '127.0.0.1:51822'; then
        UI_READY=1
        break
    fi
    sleep 1
done

if [[ "$UI_READY" -ne 1 ]]; then
    sudo docker logs --tail 100 edge-gateway
    echo "[ОШИБКА] Web UI не начал слушать 127.0.0.1:51822 за 60 секунд." >&2
    exit 1
fi

HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:51822/)"
if [[ ! "$HTTP_CODE" =~ ^(200|30[0-9])$ ]]; then
    echo "[ОШИБКА] Web UI вернул HTTP $HTTP_CODE." >&2
    exit 1
fi

echo "Контейнер: $CONTAINER_STATE"
echo "Локальный Web UI: HTTP $HTTP_CODE на 127.0.0.1:51822"

WG_CONFIG_FILE="/opt/edge-gateway/config/wg1.conf"
CONFIG_READY=0
for attempt in $(seq 1 60); do
    if sudo test -s "$WG_CONFIG_FILE" && sudo grep -q '^PostDown = ' "$WG_CONFIG_FILE"; then
        CONFIG_READY=1
        break
    fi
    sleep 1
done

if [[ "$CONFIG_READY" -ne 1 ]]; then
    sudo docker logs --tail 100 edge-gateway
    echo "[ОШИБКА] WG-Easy не создал wg1.conf с PostDown за 60 секунд." >&2
    exit 1
fi

sudo sed -n 's/^PostDown = //p' "$WG_CONFIG_FILE" |
    sudo tee /opt/edge-gateway/initial-postdown.txt >/dev/null
sudo chmod 600 /opt/edge-gateway/initial-postdown.txt

if [[ ! -s /opt/edge-gateway/initial-postdown.txt ]]; then
    echo "[ОШИБКА] Не удалось сохранить первоначальный PostDown для последующей очистки." >&2
    exit 1
fi

echo "Первоначальный PostDown сохранён локально для удаления временных правил после настройки."
echo "[УСПЕХ] Этап 5: WG-Easy v15.5.0 запущен, начальная конфигурация сохранена для очистки."
~~~

На этом этапе Web UI должен быть доступен только через loopback. Не публикуйте TCP/51822 в сетевом экране провайдера и не меняйте HOST на 0.0.0.0.

До окончания мастера WG-Easy использует временные исходные параметры интерфейса (в частности UDP/51820, стандартные адрес и сетевое устройство). Не открывайте UDP/51820 извне. На этапе 9 ниже предусмотрена очистка временных правил PostUp, чтобы после смены порта, CIDR и Device не оставить старые правила NAT/INPUT в системе.

Проверить конфигурацию контейнера можно командой:

~~~bash
sudo docker inspect edge-gateway \
  --format 'network={{.HostConfig.NetworkMode}} restart={{.HostConfig.RestartPolicy.Name}}'
~~~

Ожидается network=host и restart=unless-stopped.

## Этап 6. Подготовка изоляции пиров и правил пересылки

Этот этап создаёт скрипт и systemd-службу. Сама служба будет включена **после** первоначального мастера WG-Easy, когда появится интерфейс wg1 и его IPv4-подсеть.

Схема повторяет Дубль:

1. wg1 → wg1 — DROP для трафика между адресами VPN-подсети: пиры изолированы друг от друга.
2. Внешний интерфейс VPS → wg1 — ACCEPT только для established,related и только к адресу VPN-подсети.
3. wg1 → внешний интерфейс VPS — ACCEPT только от адресов VPN-подсети.

Правила устанавливаются через nft в цепочку ip filter DOCKER-USER и вставляются в начало цепочки (insert), чтобы они обрабатывались до последующих правил Docker. Обычный add для этой задачи не подходит: правило может оказаться за завершающим RETURN и не сработать.

В новой установке адрес VPN-подсети не зашивается в скрипт. После создания wg1 он будет считан с самого интерфейса, а затем преобразован в сетевой CIDR. Внешний интерфейс VPS берётся из /etc/default/edge-gateway-nft-rules, сформированного на этапе 4.

### 6.1. Создание скрипта правил

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 6.1, код $rc, строка $LINENO" >&2' ERR

sudo tee /usr/local/sbin/edge-gateway-nft-rules >/dev/null <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="/etc/default/edge-gateway-nft-rules"
WG_INTERFACE="wg1"
CHAIN_FAMILY="ip"
CHAIN_TABLE="filter"
CHAIN_NAME="DOCKER-USER"

EGRESS_COMMENT="edge-gateway-wg1-egress"
RETURN_COMMENT="edge-gateway-wg1-return"
ISOLATION_COMMENT="edge-gateway-wg1-peer-isolation"

if [[ ! -r "$ENV_FILE" ]]; then
    echo "Не найден $ENV_FILE" >&2
    exit 1
fi

source "$ENV_FILE"

if [[ -z "$WAN_IFACE" ]]; then
    echo "В $ENV_FILE не задан WAN_IFACE" >&2
    exit 1
fi

wait_for_chain() {
    for _ in $(seq 1 60); do
        if nft list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    echo "Цепочка ip filter DOCKER-USER не появилась. Проверьте Docker и iptables backend." >&2
    return 1
}

get_wg_network() {
    local address

    for _ in $(seq 1 60); do
        if [[ -d "/sys/class/net/$WG_INTERFACE" ]]; then
            address="$(ip -4 -o address show dev "$WG_INTERFACE" scope global | awk 'NR == 1 {print $4}')"
            if [[ -n "$address" ]]; then
                python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$address"
                return 0
            fi
        fi
        sleep 1
    done

    echo "Не удалось получить IPv4-адрес интерфейса $WG_INTERFACE." >&2
    return 1
}

rule_handles() {
    nft -a list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" |
        awk '
            /comment "edge-gateway-wg1-(egress|return|peer-isolation)"/ {
                for (i = 1; i <= NF; i++) {
                    if ($i == "handle") print $(i + 1)
                }
            }
        '
}

apply_rules() {
    wait_for_chain

    if [[ ! -d "/sys/class/net/$WAN_IFACE" ]]; then
        echo "Внешний интерфейс $WAN_IFACE не существует." >&2
        return 1
    fi

    WG_CIDR="$(get_wg_network)"
    echo "WireGuard interface: $WG_INTERFACE"
    echo "VPN network: $WG_CIDR"
    echo "WAN interface: $WAN_IFACE"

    if ! nft -a list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" | grep -F "$EGRESS_COMMENT" >/dev/null; then
        nft insert rule "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" \
            iifname "$WG_INTERFACE" oifname "$WAN_IFACE" \
            ip saddr "$WG_CIDR" counter accept \
            comment "$EGRESS_COMMENT"
    fi

    if ! nft -a list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" | grep -F "$RETURN_COMMENT" >/dev/null; then
        nft insert rule "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" \
            iifname "$WAN_IFACE" oifname "$WG_INTERFACE" \
            ip daddr "$WG_CIDR" ct state established,related counter accept \
            comment "$RETURN_COMMENT"
    fi

    if ! nft -a list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" | grep -F "$ISOLATION_COMMENT" >/dev/null; then
        nft insert rule "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" \
            iifname "$WG_INTERFACE" oifname "$WG_INTERFACE" \
            ip saddr "$WG_CIDR" ip daddr "$WG_CIDR" counter drop \
            comment "$ISOLATION_COMMENT"
    fi

    echo "Все три правила edge-gateway присутствуют."
}

remove_rules() {
    if ! nft list chain "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" >/dev/null 2>&1; then
        return 0
    fi

    while IFS= read -r handle; do
        [[ -n "$handle" ]] || continue
        nft delete rule "$CHAIN_FAMILY" "$CHAIN_TABLE" "$CHAIN_NAME" handle "$handle"
    done < <(rule_handles | sort -rn)

    echo "Правила edge-gateway удалены."
}

if [[ $# -eq 0 ]]; then
    set -- apply
fi

case "$1" in
    apply)  apply_rules ;;
    remove) remove_rules ;;
    *)
        echo "Использование: $0 {apply|remove}" >&2
        exit 2
        ;;
esac
EOF

sudo chown root:root /usr/local/sbin/edge-gateway-nft-rules
sudo chmod 750 /usr/local/sbin/edge-gateway-nft-rules

echo "[УСПЕХ] Этап 6.1: скрипт правил создан."
~~~

### 6.2. Создание systemd-службы

Служба использует ту же зависимость от Docker, что и на Дубле. PartOf=docker.service обеспечивает остановку/повторный запуск службы при перезапуске Docker. При старте скрипт дождётся DOCKER-USER и появления IPv4-адреса на wg1.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 6.2, код $rc, строка $LINENO" >&2' ERR

sudo tee /etc/systemd/system/edge-gateway-nft-rules.service >/dev/null <<'EOF'
[Unit]
Description=Edge Gateway IPv4 forwarding and WireGuard peer isolation rules
Wants=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/edge-gateway-nft-rules apply
ExecStop=/usr/local/sbin/edge-gateway-nft-rules remove
TimeoutStartSec=150

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

echo "[УСПЕХ] Этап 6.2: скрипт и systemd-служба созданы."
echo "Важно: службу пока НЕ включать. Это будет сделано на этапе 9.3 после первичной настройки интерфейса WG-Easy."
~~~

До завершения мастера WG-Easy не выполняйте systemctl enable --now для этой службы: сетевого интерфейса wg1 ещё может не быть.

Для этой схемы Docker должен использовать штатную bridge-сеть `bridge` и iptables firewall backend. Не отключайте default bridge (параметр `--bridge=none`), не задавайте `iptables=false` и не переключайте Docker на native nftables backend: в этих режимах цепочка DOCKER-USER может отсутствовать или не участвовать в пересылке.

После создания скрипта проверьте, что цепочка, на которую он рассчитан, действительно создана Docker:

~~~bash
if ! sudo nft list chain ip filter DOCKER-USER >/dev/null 2>&1; then
    echo "[ОШИБКА] Docker не создал ip filter DOCKER-USER. Проверьте default bridge и firewall backend." >&2
    exit 1
fi

if ! sudo iptables -C FORWARD -j DOCKER-USER; then
    echo "[ОШИБКА] В цепочке FORWARD отсутствует переход в DOCKER-USER. Не продолжайте настройку." >&2
    exit 1
fi

echo "[УСПЕХ] Цепочка ip filter DOCKER-USER существует и вызывается из FORWARD."
~~~

При диагностике учитывайте, что Docker использует цепочку DOCKER-USER в режиме iptables. Ожидается backend nf_tables у iptables, как на Дубле. Не переключайте Docker на native nftables backend и не отключайте его управление iptables.

Проверить backend можно так:

~~~bash
iptables --version
sudo iptables -S DOCKER-USER
sudo systemctl status docker --no-pager
~~~

## Этап 7. Подготовка домена и получение TLS-сертификата

Панель будет опубликована по HTTPS на TCP/8080. Сначала Nginx на TCP/80 обслужит только проверку Let's Encrypt, затем для панели будет включён отдельный HTTPS server block.

Перед выполнением убедитесь, что:

- A-запись домена указывает на публичный IP именно нового VPS;
- входящий TCP/80 разрешён у провайдера;
- Nginx запущен.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 7, код $rc, строка $LINENO" >&2' ERR

read -r -p "Доменное имя панели (например, vpn.example.net): " DOMAIN
read -r -p "Контактный e-mail для Let's Encrypt: " CERT_EMAIL

DOMAIN_RE='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'
if [[ ! "$DOMAIN" =~ $DOMAIN_RE ]]; then
    echo "[ОШИБКА] Укажите корректное публичное доменное имя (без схемы https://, порта и пути)." >&2
    exit 1
fi
DOMAIN="${DOMAIN,,}"

if [[ -z "$CERT_EMAIL" || "$CERT_EMAIL" != *@* ]]; then
    echo "[ОШИБКА] Указан некорректный e-mail." >&2
    exit 1
fi

if ! getent ahostsv4 "$DOMAIN" >/dev/null; then
    echo "[ОШИБКА] Домен пока не разрешается в IPv4. Проверьте DNS A-запись." >&2
    exit 1
fi

echo
echo "IPv4-адреса, в которые сейчас разрешается домен:"
getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u

echo
echo "Проверка AAAA-записи:"
AAAA_RECORDS="$(dig +time=3 +tries=1 +short AAAA "$DOMAIN" || true)"
if [[ -n "$AAAA_RECORDS" ]]; then
    echo "$AAAA_RECORDS"
    echo "[ОШИБКА] В этой инструкции панель публикуется по IPv4. Удалите AAAA-запись домена, дождитесь обновления DNS и повторите этап 7." >&2
    exit 1
fi
echo "AAAA-записей не обнаружено."

echo
echo "Сверьте IPv4-адреса с публичным IP нового VPS."
read -r -p "DNS A-запись проверена и указывает на этот VPS? Введите YES: " DNS_CONFIRMED

if [[ "$DNS_CONFIRMED" != "YES" ]]; then
    echo "[ОШИБКА] Сначала исправьте DNS и повторите этап 7." >&2
    exit 1
fi

sudo install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge

sudo tee /etc/nginx/sites-available/edge-gateway-panel >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 404;
    }
}
EOF

sudo ln -sfn /etc/nginx/sites-available/edge-gateway-panel \
    /etc/nginx/sites-enabled/edge-gateway-panel

sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

sudo certbot certonly \
    --webroot \
    --webroot-path /var/www/letsencrypt \
    --domain "$DOMAIN" \
    --email "$CERT_EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

sudo test -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
sudo test -s "/etc/letsencrypt/live/$DOMAIN/privkey.pem"

echo "[УСПЕХ] Этап 7: сертификат для $DOMAIN получен."
~~~

Если Certbot завершился ошибкой, не переходите к следующему этапу. Чаще всего причина — DNS ещё не обновился, указан не тот IP или входящий TCP/80 закрыт у провайдера.

## Этап 8. Публикация панели на TCP/8080 и Basic Auth

Создаётся отдельная учётная запись Basic Auth. Это дополнительный пароль Nginx; он не заменяет логин и пароль WG-Easy.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 8, код $rc, строка $LINENO" >&2' ERR

read -r -p "Повторно введите доменное имя панели: " DOMAIN
read -r -p "Логин дополнительной Basic Auth: " PANEL_USER

DOMAIN_RE='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'
if [[ ! "$DOMAIN" =~ $DOMAIN_RE || ! "$PANEL_USER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    echo "[ОШИБКА] Укажите корректный домен и логин из латинских букв, цифр, точки, дефиса или подчёркивания." >&2
    exit 1
fi
DOMAIN="${DOMAIN,,}"

if ! sudo test -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" || ! sudo test -s "/etc/letsencrypt/live/$DOMAIN/privkey.pem"; then
    echo "[ОШИБКА] Для $DOMAIN не найден сертификат. Повторите этап 7 с тем же доменом." >&2
    exit 1
fi

if sudo test -f /etc/nginx/.htpasswd-wgeasy; then
    sudo htpasswd -B /etc/nginx/.htpasswd-wgeasy "$PANEL_USER"
else
    sudo htpasswd -cB /etc/nginx/.htpasswd-wgeasy "$PANEL_USER"
fi

sudo chown root:www-data /etc/nginx/.htpasswd-wgeasy
sudo chmod 640 /etc/nginx/.htpasswd-wgeasy

sudo tee /etc/nginx/sites-available/edge-gateway-panel >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 404;
    }
}

server {
    listen 8080 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    auth_basic "WG-Easy";
    auth_basic_user_file /etc/nginx/.htpasswd-wgeasy;

    location / {
        proxy_pass http://127.0.0.1:51822;
        proxy_http_version 1.1;

        proxy_set_header Host              \$http_host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host  \$http_host;
        proxy_set_header X-Forwarded-Port  \$server_port;
        proxy_set_header X-Forwarded-Proto https;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
EOF

sudo nginx -t
sudo systemctl reload nginx

PANEL_HTTP_CODE="$(curl -k -sS -o /dev/null -w '%{http_code}' \
    --resolve "$DOMAIN:8080:127.0.0.1" "https://$DOMAIN:8080/")"

if [[ "$PANEL_HTTP_CODE" != "401" ]]; then
    echo "[ОШИБКА] Ожидался HTTP 401 от Basic Auth, получен HTTP $PANEL_HTTP_CODE." >&2
    exit 1
fi

echo "[УСПЕХ] Этап 8: Nginx слушает HTTPS/TCP 8080; Basic Auth отвечает HTTP 401 без пароля."
~~~

HTTP 401 в последней проверке — ожидаемый результат: Nginx требует дополнительную авторизацию, прежде чем передать запрос в WG-Easy.

### 8.1. Автоматическое обновление сертификата

После продления сертификата Nginx должен перечитать новые файлы.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 8.1, код $rc, строка $LINENO" >&2' ERR

sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy

sudo tee /etc/letsencrypt/renewal-hooks/deploy/edge-gateway-reload-nginx >/dev/null <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF

sudo chmod 750 /etc/letsencrypt/renewal-hooks/deploy/edge-gateway-reload-nginx

sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
sudo systemctl is-active --quiet certbot.timer

echo "[УСПЕХ] Этап 8.1: таймер Certbot активен, тестовое продление выполнено."
~~~

## Этап 9. Первоначальная настройка через веб-интерфейс

Откройте в браузере:

~~~text
https://<ДОМЕН_ПАНЕЛИ>:8080
~~~

Сначала браузер запросит логин и пароль Nginx Basic Auth — те, которые были заданы на этапе 8. После этого откроется мастер WG-Easy.

### 9.1. Первичное создание учётной записи WG-Easy

1. Укажите имя пользователя администратора WG-Easy.
2. Установите отдельный сложный пароль и повторите его.
3. На вопрос об использовании существующей конфигурации выберите **No** — это новая установка, не импорт старой базы.
4. В поле Host укажите публичный IP нового VPS или его доменное имя.
5. В поле Port укажите **443**. Это публичный UDP-порт WireGuard, а не порт веб-панели.

Не вводите адрес старого VPS. Значение Host должно соответствовать новому серверу. Важное различие: PORT=51822 в Docker Compose — внутренний TCP-порт Web UI; TCP/8080 — внешний HTTPS-порт Nginx; Port=443 в мастере — UDP-порт WireGuard.

### 9.2. Общие параметры WG-Easy

Откройте меню пользователя в правом верхнем углу → **Admin Panel**.

#### Config

Проверьте следующие параметры:

| Поле | Что установить |
|---|---|
| Host | Публичный IP или домен нового VPS |
| Port | 443 |
| Allowed IPs | 0.0.0.0/0 |
| DNS | 1.1.1.1 |
| MTU | 1420 |
| Persistent Keepalive | 0 (выключено по умолчанию; для отдельных клиентов задаётся отдельно при необходимости) |

Для данной конфигурации в Allowed IPs не добавлять ::/0: IPv6 в WG-Easy отключён. Значение 0.0.0.0/0 задаёт full-tunnel для IPv4-клиентов. Это настройка маршрутизации в клиентском конфиге, а не серверное ограничение доступа: клиент может изменить её локально. Изоляцию пиров обеспечивает отдельное правило DROP на сервере.

Host, Port, Allowed IPs, DNS, MTU и Persistent Keepalive в разделе Config задают значения по умолчанию для генерируемых клиентских конфигураций. Это не настройки серверного интерфейса wg1. Preshared Key WG-Easy создаёт автоматически при создании каждого пира; отдельного переключателя Generate Preshared Keys в Admin Panel версии 15.5.0 нет.

#### Interface

Проверьте:

| Поле | Что установить |
|---|---|
| Port | 443 |
| Device | Внешний интерфейс VPS, определённый на этапе 4 |
| MTU | 1420 |
| Routing Table | auto |
| Per-Client Firewall | Не включать для воспроизведения текущей схемы Дубля |

Device должен совпадать со значением WAN_IFACE в файле /etc/default/edge-gateway-nft-rules. Например, если на этапе 4 было определено ens3, в поле Device укажите ens3, а не eth0. Это значение будет использовано штатными PostUp/PostDown для выхода VPN-клиентов через внешний интерфейс VPS.

В разделе Interface нажмите **Change CIDR** и задайте IPv4 CIDR таким же, как на Дубле (посмотреть его можно там же: Admin Panel → Interface → Change CIDR). Это сохранит ту же адресную схему VPN. Если на новом VPS или в сетях, к которым клиенты должны обращаться, возникнет пересечение подсетей, выберите другой свободный частный диапазон. Значение CIDR в публичный репозиторий не записывается. Скрипт на этапе 9.3 автоматически считает фактически назначенную подсеть с интерфейса wg1, поэтому вручную переносить её в скрипт не нужно.

Переключатель Firewall (Per-Client Firewall) в WG-Easy — отдельный экспериментальный механизм фильтрации конкретных клиентов. Он не является изоляцией пиров и не заменяет три правила DOCKER-USER, установленные на этапе 6. Для повторения схемы Дубля оставьте его выключенным.

#### General

Откройте отдельный раздел **Admin Panel → General**:

- Prometheus и JSON metrics оставить выключенными.
- Session Timeout оставить со значением по умолчанию.

#### Hooks

Откройте отдельный раздел **Admin Panel → Hooks**. На Дубле используются следующие IPv4-only Hooks. Задайте их явно, чтобы результат чистой установки совпал с существующей конфигурацией. При DISABLE_IPV6=true WG-Easy v15.5.0 также автоматически убирает свои стандартные IPv6-команды Hooks при инициализации базы.

Установите следующие значения:

**PreUp** — оставить пустым.

**PostUp** — одна строка:

~~~text
iptables -t nat -A POSTROUTING -s {{ipv4Cidr}} -o {{device}} -j MASQUERADE; iptables -A INPUT -p udp -m udp --dport {{port}} -j ACCEPT; iptables -A FORWARD -i {{interface}} -j ACCEPT; iptables -A FORWARD -o {{interface}} -j ACCEPT;
~~~

**PreDown** — оставить пустым.

**PostDown** — одна строка:

~~~text
iptables -t nat -D POSTROUTING -s {{ipv4Cidr}} -o {{device}} -j MASQUERADE; iptables -D INPUT -p udp -m udp --dport {{port}} -j ACCEPT; iptables -D FORWARD -i {{interface}} -j ACCEPT; iptables -D FORWARD -o {{interface}} -j ACCEPT;
~~~

Плейсхолдеры {{ipv4Cidr}}, {{device}}, {{interface}} и {{port}} WG-Easy заменит фактическими значениями интерфейса. Не подставляйте вручную адресную подсеть или имя сетевого адаптера. Эти Hooks задают штатный IPv4 NAT, приём WireGuard UDP/443 и базовый FORWARD. Дополнительная изоляция пиров выполняется отдельной systemd-службой на этапе 9.3.

Нажмите **Save** в разделе Hooks.

#### Очистка временных правил и применение новых Hooks

После первого запуска WG-Easy уже создал временный интерфейс и применил исходные PostUp, в которых ещё используются стандартные порт, CIDR и сетевое устройство. При изменении параметров WG-Easy перезаписывает wg1.conf до нажатия Restart Interface. Поэтому сначала удалим старые правила по сохранённому первоначальному PostDown, затем подготовим новые правила по текущему PostUp. Сам интерфейс пока не перезапускайте.

Выполните этот блок в SSH **после сохранения всех разделов Config, Interface и Hooks, но до нажатия Restart Interface**:

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Подготовка Hooks, код $rc, строка $LINENO" >&2' ERR

OLD_POSTDOWN_FILE="/opt/edge-gateway/initial-postdown.txt"
WG_CONFIG_FILE="/opt/edge-gateway/config/wg1.conf"

if ! sudo test -s "$OLD_POSTDOWN_FILE"; then
    echo "[ОШИБКА] Не найден первоначальный PostDown. Повторите этап 5 или проверьте файл." >&2
    exit 1
fi

OLD_POSTDOWN="$(sudo cat "$OLD_POSTDOWN_FILE")"
NEW_POSTUP="$(sudo sed -n 's/^PostUp = //p' "$WG_CONFIG_FILE")"

if [[ -z "$OLD_POSTDOWN" || -z "$NEW_POSTUP" ]]; then
    echo "[ОШИБКА] Не удалось прочитать первоначальный PostDown или новый PostUp." >&2
    exit 1
fi

# Удаляем исходные правила. sh продолжает выполнять последующие команды,
# даже если отдельное правило уже отсутствует.
sudo docker exec edge-gateway sh -c "$OLD_POSTDOWN" >/dev/null 2>&1 || true

# Устанавливаем правила из уже сохранённой новой конфигурации.
sudo docker exec edge-gateway sh -ec "$NEW_POSTUP"

echo "[УСПЕХ] Временные правила очищены, новые PostUp установлены. Теперь можно перезапустить интерфейс."
~~~

Теперь вернитесь в браузер, в **Admin Panel → Interface**, и нажмите **Restart Interface**. В v15.5.0 это отдельная кнопка внизу страницы. При перезапуске WG-Easy выполнит новый PostDown, а затем новый PostUp, поэтому актуальные правила останутся установленными. Клиентов на этом этапе создавать не нужно.

### 9.3. Включение изоляции пиров и пересылки трафика

После завершения мастера и сохранения параметров в Admin Panel вернитесь в SSH и выполните блок. Скрипт автоматически получит адрес интерфейса wg1, определит его подсеть и установит три правила с ограничением по этой подсети.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 9.3, код $rc, строка $LINENO" >&2' ERR

WG_PORT="$(sudo docker exec edge-gateway wg show wg1 listen-port)"
if [[ "$WG_PORT" != "443" ]]; then
    echo "[ОШИБКА] После Restart Interface WireGuard должен слушать UDP/443, фактически: UDP/$WG_PORT." >&2
    exit 1
fi

sudo rm -f /opt/edge-gateway/initial-postdown.txt

sudo systemctl enable --now edge-gateway-nft-rules.service

sudo systemctl is-enabled --quiet edge-gateway-nft-rules.service
sudo systemctl is-active --quiet edge-gateway-nft-rules.service
sudo nft -a list chain ip filter DOCKER-USER

RULE_COUNT="$(sudo nft -a list chain ip filter DOCKER-USER | grep -c 'edge-gateway-wg1-' || true)"
if [[ "$RULE_COUNT" -ne 3 ]]; then
    echo "[ОШИБКА] Ожидалось 3 правила edge-gateway, обнаружено: $RULE_COUNT" >&2
    sudo journalctl -u edge-gateway-nft-rules.service -n 100 --no-pager
    exit 1
fi

echo "[УСПЕХ] Этап 9.3: изоляция пиров и правила пересылки включены."
~~~

Если этап завершился ошибкой, не заменяйте правила широкими ACCEPT. Проверьте наличие wg1, внешний интерфейс, backend iptables и журнал службы.

Официальное руководство WG-Easy v15.5.0 по расположению этих пунктов: [Admin Panel](https://wg-easy.github.io/wg-easy/v15.5/guides/admin/).

## Этап 10. Итоговая проверка

Выполнять после завершения мастера WG-Easy и сохранения параметров Interface.

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 10, код $rc, строка $LINENO" >&2' ERR

sudo docker compose --project-directory /opt/edge-gateway \
    -f /opt/edge-gateway/compose.yaml config --quiet
sudo docker compose --project-directory /opt/edge-gateway \
    -f /opt/edge-gateway/compose.yaml ps

sudo systemctl is-active --quiet docker
sudo systemctl is-enabled --quiet edge-gateway-nft-rules.service
sudo systemctl is-active --quiet edge-gateway-nft-rules.service
sudo systemctl is-active --quiet nginx
sudo systemctl is-enabled --quiet certbot.timer

echo
echo "WireGuard interface:"
sudo docker exec edge-gateway wg show wg1 listen-port
sudo ip -brief address show wg1

WG_PORT="$(sudo docker exec edge-gateway wg show wg1 listen-port)"
if [[ "$WG_PORT" != "443" ]]; then
    echo "[ОШИБКА] WireGuard должен слушать UDP/443, фактически: $WG_PORT" >&2
    exit 1
fi

echo
echo "Firewall rules:"
sudo nft -a list chain ip filter DOCKER-USER

RULE_COUNT="$(sudo nft -a list chain ip filter DOCKER-USER | grep -c 'edge-gateway-wg1-' || true)"
if [[ "$RULE_COUNT" -ne 3 ]]; then
    echo "[ОШИБКА] Ожидалось 3 правила изоляции/пересылки, обнаружено: $RULE_COUNT" >&2
    exit 1
fi

WG_CONFIG="/opt/edge-gateway/config/wg1.conf"
if ! sudo grep -Eq '^PostUp[[:space:]]*=.*MASQUERADE' "$WG_CONFIG"; then
    echo "[ОШИБКА] В wg1.conf отсутствует штатный PostUp с MASQUERADE." >&2
    exit 1
fi
if ! sudo grep -Eq '^PostUp[[:space:]]*=.*--dport 443' "$WG_CONFIG"; then
    echo "[ОШИБКА] В wg1.conf отсутствует штатный PostUp для UDP/443." >&2
    exit 1
fi
if ! sudo grep -Eq '^PostUp[[:space:]]*=.*-i wg1 .*ACCEPT' "$WG_CONFIG" || \
   ! sudo grep -Eq '^PostUp[[:space:]]*=.*-o wg1 .*ACCEPT' "$WG_CONFIG"; then
    echo "[ОШИБКА] В wg1.conf отсутствуют штатные правила PostUp для FORWARD через wg1." >&2
    exit 1
fi
if ! sudo grep -Eq '^PostDown[[:space:]]*=.*MASQUERADE' "$WG_CONFIG" || \
   ! sudo grep -Eq '^PostDown[[:space:]]*=.*--dport 443' "$WG_CONFIG" || \
   ! sudo grep -Eq '^PostDown[[:space:]]*=.*-D FORWARD -i wg1 .*ACCEPT' "$WG_CONFIG" || \
   ! sudo grep -Eq '^PostDown[[:space:]]*=.*-D FORWARD -o wg1 .*ACCEPT' "$WG_CONFIG"; then
    echo "[ОШИБКА] В wg1.conf отсутствуют штатные PostDown для очистки NAT/UDP/FORWARD." >&2
    exit 1
fi

if sudo grep -Eq '^Post(Up|Down)[[:space:]]*=.*ip6tables' "$WG_CONFIG"; then
    echo "[ОШИБКА] В IPv4-only конфигурации обнаружены IPv6-команды Hooks." >&2
    exit 1
fi

echo "[УСПЕХ] IPv4-only PostUp/PostDown для NAT, UDP/443 и FORWARD присутствуют; IPv6-команд нет."

if sudo test -e /opt/edge-gateway/initial-postdown.txt; then
    echo "[ОШИБКА] Временный файл initial-postdown.txt не был удалён на этапе 9.3." >&2
    exit 1
fi

NETWORK_MODE="$(sudo docker inspect edge-gateway --format '{{.HostConfig.NetworkMode}}')"
if [[ "$NETWORK_MODE" != "host" ]]; then
    echo "[ОШИБКА] Контейнер должен использовать host network, обнаружено: $NETWORK_MODE" >&2
    exit 1
fi

echo
echo "Проверка локального Web UI:"
sudo ss -lntp | grep '127.0.0.1:51822'

echo
echo "Проверка внешнего HTTPS listener:"
sudo ss -lntp | grep ':8080'

echo
IP_FORWARD="$(sysctl -n net.ipv4.ip_forward)"
echo "IPv4 forwarding: $IP_FORWARD"
if [[ "$IP_FORWARD" != "1" ]]; then
    echo "[ОШИБКА] IPv4 forwarding должен быть равен 1." >&2
    exit 1
fi
echo "[УСПЕХ] Этап 10: основные компоненты установлены и проверки пройдены."
~~~

В результате должны выполняться все условия:

- контейнер edge-gateway работает и использует host network;
- интерфейс wg1 существует и слушает UDP/443;
- Web UI слушает только 127.0.0.1:51822;
- Nginx принимает HTTPS на TCP/8080;
- без Basic Auth панель отвечает HTTP 401;
- IPv4 forwarding включён;
- в DOCKER-USER присутствуют три правила с комментариями edge-gateway-wg1-*;
- служба edge-gateway-nft-rules включена в автозапуск;
- Certbot timer активен.

На чистом сервере в списке WG-Easy пока не должно быть созданных клиентских пиров.

## Этап 11. Проверка восстановления после перезагрузки

Перезагрузите VPS:

~~~bash
sudo reboot
~~~

После повторного подключения по SSH выполните:

~~~bash
set -Eeuo pipefail
trap 'rc=$?; echo "[ОШИБКА] Этап 11, код $rc, строка $LINENO" >&2' ERR

sudo systemctl is-active --quiet docker
sudo systemctl is-active --quiet nginx
sudo systemctl is-active --quiet edge-gateway-nft-rules.service
sudo systemctl is-active --quiet certbot.timer

CONTAINER_STATE="$(sudo docker inspect edge-gateway --format '{{.State.Status}}')"
if [[ "$CONTAINER_STATE" != "running" ]]; then
    echo "[ОШИБКА] После перезагрузки контейнер edge-gateway не запущен: $CONTAINER_STATE" >&2
    exit 1
fi

WG_PORT="$(sudo docker exec edge-gateway wg show wg1 listen-port)"
if [[ "$WG_PORT" != "443" ]]; then
    echo "[ОШИБКА] После перезагрузки WireGuard слушает не UDP/443, а UDP/$WG_PORT." >&2
    exit 1
fi

sudo nft -a list chain ip filter DOCKER-USER

RULE_COUNT="$(sudo nft -a list chain ip filter DOCKER-USER | grep -c 'edge-gateway-wg1-' || true)"
if [[ "$RULE_COUNT" -ne 3 ]]; then
    echo "[ОШИБКА] После перезагрузки не восстановились все три firewall-правила." >&2
    exit 1
fi

echo "[УСПЕХ] Этап 11: Docker, WG-Easy, Nginx и firewall-служба восстановились после перезагрузки."
~~~

## Диагностика при неудаче

### WG-Easy

~~~bash
sudo docker compose -f /opt/edge-gateway/compose.yaml ps
sudo docker logs --tail 150 edge-gateway
sudo docker inspect edge-gateway --format '{{.State.Status}} {{.State.Health.Status}}'
sudo docker exec edge-gateway wg show wg1
~~~

### Firewall и маршрутизация

~~~bash
sudo systemctl status edge-gateway-nft-rules.service --no-pager
sudo journalctl -u edge-gateway-nft-rules.service -b --no-pager
sudo nft -a list chain ip filter DOCKER-USER
ip -4 route show default
sysctl net.ipv4.ip_forward
~~~

### Nginx и сертификат

~~~bash
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx -n 100 --no-pager
sudo certbot certificates
sudo systemctl status certbot.timer --no-pager
~~~

Не публикуйте вывод wg show целиком, содержимое базы WG-Easy, клиентские конфигурации, ключи, пароли или резервные копии.

## Важные замечания

1. Не изменяйте вручную /opt/edge-gateway/config/wg1.conf. Конфигурацией интерфейса и клиентов управляет WG-Easy.
2. Не меняйте имя интерфейса wg1, порт UDP/443, HOST/PORT Web UI и TRUSTED_PROXIES без одновременной проверки зависимых настроек.
3. Не открывайте TCP/51822 во внешнем сетевом экране. Доступ к панели должен идти через Nginx на TCP/8080.
4. Не удаляйте правила DOCKER-USER вручную. Для удаления только правил этого помощника используйте команду:

   ~~~bash
   sudo /usr/local/sbin/edge-gateway-nft-rules remove
   ~~~

5. Файл /opt/edge-gateway/config/wg-easy.db и остальные данные каталога config содержат закрытые ключи и чувствительные настройки. Резервные копии хранить только локально или в защищённом частном хранилище. Не загружать их в GitHub.
6. В репозитории сохраняются только шаблоны и документация. Реальные IP-адреса, домен, VPN CIDR, логины, пароли, ключи и данные пиров в него не добавлять.

## Источники

- [WG-Easy v15.5.0 — Setup](https://wg-easy.github.io/wg-easy/v15.5/guides/setup/)
- [WG-Easy v15.5.0 — Optional Configuration](https://wg-easy.github.io/wg-easy/v15.5/advanced/config/optional-config/)
- [WG-Easy v15.5.0 — Admin Panel](https://wg-easy.github.io/wg-easy/v15.5/guides/admin/)
- [Docker Engine — установка на Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker — bridge networking](https://docs.docker.com/engine/network/drivers/bridge/)
- [Docker — iptables и цепочка DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/)
- [Документация этого репозитория — серверная схема WG-Easy](vps-to-keenetic-via-wg-easy.md)
- [Документация этого репозитория — HTTPS, Nginx и порт панели](vps-media-services-https.md)
