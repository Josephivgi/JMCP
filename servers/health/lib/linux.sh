# Collects health facts on Linux. Prints "@@section" headers followed by raw
# command output; analyze.js parses it. Runs as plain sh, any user, no sudo.
LC_ALL=C; export LC_ALL
ms() { if s=$(date +%s%N 2>/dev/null) && [ "${s%N}" = "$s" ]; then echo $((s / 1000000)); else echo $(($(date +%s) * 1000)); fi; }
echo "@@uname"; uname -srm
echo "@@hostname"; hostname 2>/dev/null || cat /etc/hostname
echo "@@osrelease"; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "@@uptime"; cat /proc/uptime
echo "@@loadavg"; cat /proc/loadavg
echo "@@nproc"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo "@@cpumodel"; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-
echo "@@meminfo"; cat /proc/meminfo
echo "@@df"; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null
echo "@@dfi"; df -P -i -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null
echo "@@stat1"; head -1 /proc/stat
sleep 1
echo "@@stat2"; head -1 /proc/stat
echo "@@ps"; ps -eo comm,pcpu,rss --sort=-pcpu 2>/dev/null | head -n 16
echo "@@psmem"; ps -eo comm,pcpu,rss --sort=-rss 2>/dev/null | head -n 8
echo "@@psi"; for r in cpu memory io; do [ -r /proc/pressure/$r ] && echo "$r $(head -1 /proc/pressure/$r)"; done
echo "@@oom"; (journalctl -k --since "-7 days" --no-pager -q 2>/dev/null || dmesg 2>/dev/null) | grep -ciE 'out of memory|killed process|oom-kill'
echo "@@ioerr"; (journalctl -k --since "-7 days" --no-pager -q 2>/dev/null || dmesg 2>/dev/null) | grep -ciE 'i/o error|blk_update_request|ata[0-9.]*: .*error|nvme.*(timeout|reset)|ext4-fs error|xfs.*corrupt|mce: '
echo "@@errors"; journalctl -p 3 -b --no-pager -q -o cat 2>/dev/null | sort | uniq -c | sort -rn | head -n 12
echo "@@failed"; systemctl --failed --no-legend --plain 2>/dev/null | head -n 20
echo "@@thermal"; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n 8
echo "@@reboot"; [ -f /var/run/reboot-required ] && echo yes
echo "@@zombies"; ps -eo stat 2>/dev/null | grep -c '^Z'
echo "@@dstate"; ps -eo stat,comm 2>/dev/null | awk '$1 ~ /^D/ {print $2}' | head -n 10
echo "@@dns"; a=$(ms); getent hosts www.google.com >/dev/null 2>&1; b=$(ms); echo $((b - a))
echo "@@ping"; ping -c 4 -W 2 1.1.1.1 2>/dev/null | tail -n 2
echo "@@conns"; (ss -s 2>/dev/null || netstat -s 2>/dev/null) | head -n 3
echo "@@docker"; docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | head -n 30
echo "@@end"
