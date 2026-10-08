# EEG Image Exporter

独立的 EEG 标注底图生成器。它位于标注器仓库中，但不依赖标注器服务或 Detection 代码。

## 安装与运行

```powershell
cd E:\eeg-image-annotator
python -m pip install -r image_exporter\requirements.txt
python -m image_exporter.export_images
```

运行前编辑 `image_exporter\config.py`。也可以用 `--edf-folder`、`--output-root`、`--dataset-name`、`--recording-name`、`--channels`、`--sleep-stage-file` 和 `--sleep-stage-scorer` 覆盖常用参数。

## 输入

- 一个 EDF 文件，或按 `[001].edf`、`[002].edf` 编号的 SouthData 分块。
- 可选 SouthData RML 分期文件。
- 用户指定的通道顺序、显示滤波和图片尺寸。

多个 EDF 若没有 `[NNN]` 编号会被拒绝，避免错误拼接。

## 输出

```text
<IMAGE_LIBRARY_ROOT>\<dataset>\<recording>\image_sets\<set_name>\
├─ images\
│  ├─ epoch_000001.png
│  └─ ...
├─ images_manifest.json
└─ render_config.json
```

输出契约与标注器保持一致：图片宽度固定、总高度随通道数变化；manifest 包含 recording 身份、epoch 时间、通道几何、分期和每个 epoch 的纵轴幅度。

## 绘图规则

- 每个 epoch 的所有通道共享纵轴。
- 绝对峰值不超过 `AMPLITUDE_UV` 时使用 `±AMPLITUDE_UV`；超出时使用该 epoch 的绝对峰值。
- 标题为 `EPOCH index|分期|滤波方法`。
- LOC/ROC 为蓝色，其他通道为深灰色。
- 每 1 秒细线，每 5 秒粗线。

## 测试

```powershell
cd E:\eeg-image-annotator
python -m unittest -v image_exporter.test_export_images
```

测试覆盖通道别名、EDF 排序、RML 分期、纵轴规则、标题、颜色和时间网格，不需要 Detection。
