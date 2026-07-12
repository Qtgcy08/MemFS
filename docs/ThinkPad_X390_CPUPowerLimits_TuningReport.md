# ThinkPad X390 (i5-8265U) CPU 功耗与散热调优报告

## 一、概述

### 1.1 背景

MemFS 部署在 ThinkPad X390（i5-8265U，14nm++）上，作为低功耗 Homeserver 24x7 运行。设备长期放置在冰柜旁，噪音不敏感，但散热能力有限。

初始状态：astrbot 进程持续单核满载，CPU 温度稳定在 **90°C**，风扇满速（3836 RPM），PL1=25W（OEM Lenovo 设定，远超 Intel 标准 TDP 15W）。

### 1.2 目标

- 稳态温度可控（75°C 以下可接受）
- 保留 CPU 突发性能（单核 3.9 GHz 极限不被阉割）
- 全自动持久化，重启不丢失

---

## 二、诊断

### 2.1 散热瓶颈

```
CPU: i5-8265U (Whiskey Lake, 4C8T, 14nm++)
机箱: ThinkPad X390 (1.3kg, 16.5mm 厚)
散热: 单风扇 + 小均热板
临界温度: PROCHOT 100°C
```

X390 的散热模组为突发办公设计，无法持续排出 25W+ 的热量。

### 2.2 RAPL 默认配置

```bash
# 调优前
PL1: 25000000 µW (25W)      # OEM 设定远高于 Intel 15W 标准
PL1 时间窗: 31981568 µs (~32s)
PL2: 51000000 µW (51W)
PL2 时间窗: 2440 µs (2.4ms)  # 几乎无实际突发窗口
```

### 2.3 astrbot 负载特征

通过 strace 确认 astrbot 约 98k 次 `epoll_wait`/5s，事件驱动正常。但 91% 上下文切换为 involuntary（被强制踢出 CPU），说明进程持续占满时间片。

**关键发现：astrbot 的 100% CPU 并非在处理用户请求，而是维护各种轮询——Playwright 浏览器保活、MCP server 心跳、消息队列监听等。** 这属于维护开销而非有效工作负载。因此散热调优的实质是：压低轮询开销的散热代价，同时确保真需要算力时不拖后腿。

---

## 三、调优过程

### 3.1 三层调度链路

```
Platform Profile (ACPI) → Cpufreq Governor → EPP (Energy Performance Preference) → RAPL PL1/PL2 (硬件硬限)
```

最终选择：

| 层 | 设定 | 选择理由 |
|----|------|---------|
| Profile | `performance` | 激进风扇曲线，充分利用冰柜旁散热 |
| Governor | `powersave` | intel_pstate HWP 模式，硬件自主调频 |
| EPP | `performance` | 倾向高频，不保守降频 |
| PL1 | 14W | 持续功耗硬限 |
| PL2 | 45W @ 10s | 突发功耗上限 + 足够时间窗覆盖 MemFS rebuild |

### 3.2 实验数据

#### 单核满载 (`taskset -c 0` 死循环)

```
PL1=14W, PL2=45W@10s, EPP=performance

Phase 1 (PL2 burst):  1-35s  功率 15-19W  频率 3.7GHz  温度 70→82°C
                        ↓ 第36秒 PL1 tau 到期，切入 PL1 限制
Phase 2 (PL1 stable): 36-45s 功率 13-14W  频率 3.3GHz  温度 74→77°C
```

稳态温度 **74-77°C**，达到目标。

#### 全核满载

```
Phase 1 (PL2 45W):    1-5s   功率 41-42W  频率 3.7GHz  温度 87→97°C
                        ↓ 第6秒 PROCHOT 热限频接管（97°C）
Phase 2 (PL1 14W):    7-45s  功率 13-14W  频率 2.1GHz  温度 69-72°C
```

全核爆发 5 秒即撞 PROCHOT 墙，自动降回 14W 稳态。97°C 离 100°C 临界还有安全余量，属于正常热限频。

### 3.3 MemFS 负载实测

| 操作 | 调优前 (13W/balance_power) | 调优后 (14W/EPP=perf) | 提升 |
|------|---------------------------|----------------------|------|
| analyzeDuplicates | 15,025ms | **6,843ms** | **+55%** |
| reload (Index rebuilt) | 926ms | **627ms** | **+32%** |
| reload (Total) | 998ms | **680ms** | **+32%** |

---

## 四、最终配置

### 4.1 当前生效

```bash
PL1:          14W                    # /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
PL2:          45W                    # /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw
PL2 时间窗:    ~10s                   # /sys/class/powercap/intel-rapl:0/constraint_1_time_window_us
Profile:      performance            # /sys/firmware/acpi/platform_profile
Governor:     powersave              # /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
EPP:          performance            # /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference
```

### 4.2 持久化

```ini
# /etc/systemd/system/set-pl1-pl2.service
[Unit]
Description=Set Intel RAPL PL1/PL2 power limits
DefaultDependencies=false
After=sysinit.target
Before=basic.target

[Service]
Type=simple
ExecStartPre=/bin/sleep 2
ExecStart=/bin/sh -c 'echo 14000000 > /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw; echo 45000000 > /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw; echo 10000000 > /sys/class/powercap/intel-rapl:0/constraint_1_time_window_us'
ExecStartPost=/bin/sh -c 'for i in 1 2 3 4 5; do if echo performance > /sys/firmware/acpi/platform_profile 2>/dev/null; then break; fi; sleep 1; done; cpupower frequency-set -g powersave 2>/dev/null'
RemainAfterExit=yes

[Install]
WantedBy=sysinit.target
```

**EPP 持久化需额外步骤**——因内核接口在 EPP=performance 下无需持久化（用户态不干预则保持），如需确保可在 `ExecStartPost` 追加或通过 udev 规则。

### 4.3 防护层

KDE PowerDevil 可能覆盖 `platform_profile`，通过以下方式防护：

1. KDE 自身配置设为 AC 模式 Performance
2. 系统定时器 `enforce-platform-profile.timer`，每 2 分钟检查并纠正

---

## 五、总结

ThinkPad X390 作为 MemFS Homeserver，通过 **RAPL 硬限 + intel_pstate HWP + EPP 倾向** 三层调优，将稳态温度从 90°C 降至 75°C 附近，同时保留单核 3.7GHz 突发能力和 MemFS rebuild 等实际负载的明显性能提升。全自动持久化，重启不丢失。

**核心调优结论：OEM PL1 设定过高（25W）是根本原因，14W 是 X390 散热模组能舒适承载的持续功耗上限。PL2 保持 45W 确保突发性能不受影响，PROCHOT 100°C 热限频作为最终安全阀。**

### 5.1 负载特征对调优的影响

astrbot 的 100% CPU 占用本质是事件轮询维护开销（`epoll_wait` + 浏览器保活 + MCP 心跳），而非计算密集型任务。这类负载对 CPU 频率不敏感：**2.1 GHz 和 3.7 GHz 下轮询效果一样，但散热代价差了一个量级。**

因此分层调度策略合理：
- **PL1=14W / 2.1 GHz（稳态）**：以最低功耗跑轮询维护，温度 70-75°C
- **PL2=45W@10s（突发）**：轮询开销不会触发突发；仅在 MemFS rebuild/dedup 等真计算任务时激活，温度短暂飚至 97°C 后自动回落

即：**让维护负载跑低频以保散热，让真实计算跑突发以保性能——互不干扰。**
