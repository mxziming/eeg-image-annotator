# EEG Image Annotator

本地 EEG 图片标注器。底图由仓库内独立工具 `image_exporter` 生成；标注器服务只负责发现图片集、读取 manifest、交互标注、保存进度和导出 CSV。生成器不依赖 Detection。

## 启动

```powershell
cd E:\eeg-image-annotator
python server.py
```

打开 `http://127.0.0.1:8765`。本服务仅使用 Python 标准库，`requirements.txt` 不再包含绘图依赖。

## 工作流

1. 编辑 `image_exporter\config.py` 中的 EDF、输出根目录、通道、滤波、分期、DPI 和尺寸。
2. 在本目录运行 `python -m image_exporter.export_images`，生成不可变图片集及 `images_manifest.json`。
3. 在标注器选择 **项目 → 创建项目**，填写外部 `image_sets` 目录与标注项目目录。
4. 通过 **项目 → 切换外部底图** 选择图片集。通道位置由 manifest 自动加载，仍可手工校准。
5. 绘制事件框，或通过 **数据 → 加载CSV标注** 导入 Detection 长表。
6. 保存 `working.json`，或导出规范 CSV。

```text
E:\EEGAnnotationData\<dataset>\<recording>\image_sets\
  set_YYYYMMDD_HHMMSS_xxxxxxxx\
    images\epoch_000001.png
    images_manifest.json
    render_config.json
```

## 事件契约

```text
type,start_epoch,start_offset,end_epoch,end_offset,channel,dataset_name,image_name,duration_s,annotation_id
```

- `annotation_id` 始终标识一个逻辑事件。
- K/S 是 channel-level：多通道行共享同一 `annotation_id`。
- A 手工标注默认为 `GLOBAL`；Detection 导入也允许六个标准 EEG 通道。
- REM/SEM 是 event-level，通道固定为 `LOC;ROC`。
- MBM 是 event-level，通道固定为 `GLOBAL`。
- `image_name` 是 recording 标识，必须等于 manifest 的 `recordingName`，不是 PNG 文件名。
- offset 满足 `0 <= offset < epoch_length_sec`；`duration_s` 必须等于起止时间差。

跨 epoch 事件在 `state.events` 中仍是一个事件；界面投影到多张图片，导出时不会拆成多个逻辑事件。

manifest 顶层提供 `datasetName`、`recordingName`、`epochLengthSec`、`epochBase`、`canvas`、`channels` 和 `images`。每个通道提供 `name`、`topPct`、`bottomPct`。图片宽度固定，总高度随通道数增长。

旧项目的 `images_dir` 可兼容读取，但页面不再提供 EDF 读取、底图生成、任务恢复或生成缓存管理。

## 测试

```powershell
node test-import.js
python -m unittest -v test_workflow.py
```
