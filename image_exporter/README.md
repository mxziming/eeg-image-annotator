# EEG Image Exporter

一个 EEG 波形图生成器，它位于标注器仓库中，但不依赖标注器或其他部分的代码，可以独立控制滤波方法、通道个数、输入数据等，生成无任何标注的底图。

## 安装与运行

```powershell
cd E:\eeg-image-annotator
python -m pip install -r image_exporter\requirements.txt
python -m image_exporter.export_images
```



运行前编辑 `image_exporter\config.py`设置参数，也可以在命令行用 `--edf-folder`、`--output-root`、`--dataset-name`、`--recording-name`、`--channels`、`--sleep-stage-file` 和 `--sleep-stage-scorer` 等命令覆盖常用参数。

## 输入

- 原始数据：一个 EDF 文件，或按 `[001].edf`、`[002].edf` 编号的多个 EDF 文件。
- 分期文件：可选 RML 分期文件。
- 其他参数：用户指定的通道顺序、显示滤波和图片尺寸。

多个 EDF 若没有以数字编号结尾会被拒绝，避免错误拼接。

## 输出

```text
<IMAGE_LIBRARY_ROOT>\<dataset>\<recording>\image_sets\<set_name>\
├─ images\
│  ├─ epoch_000001.png
│  └─ ...
├─ images_manifest.json
└─ render_config.json
```



manifest 包含 recording 身份、epoch 时间、通道几何、分期和每个 epoch 的纵轴幅度。

## 绘图规则

- 每个 epoch 的所有通道共享纵轴。
- 绝对峰值不超过 `AMPLITUDE_UV` 时使用 `±AMPLITUDE_UV`；超出时使用该 epoch 的绝对峰值。
- 标题为 `EPOCH index|分期|滤波方法`。
- LOC/ROC 为蓝色，其他通道为深灰色。
- 每 1 秒细线，每 5 秒粗线。
