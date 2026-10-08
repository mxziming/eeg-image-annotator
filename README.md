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
3. 在标注器选择 **项目 → 创建项目**，填写底图子目录与项目位置。
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

导入时接受 Detection 的标准九列长表；`annotation_id` 是可选的第十列。缺失或留空时，标注器会根据 dataset、recording、事件类型和起止时间生成稳定的 event-level ID，并写入当前 `working.json`。之后从标注器导出的 CSV 始终包含第十列 `annotation_id`。

对于缺少 `annotation_id` 的 K/S channel-level 行，起止时间不必完全一致。相同 dataset、recording 和事件类型、不同通道的区间，在共同时间交集分别达到每个成员区间时长的 50% 或以上时合并为一个逻辑事件。合并只赋予相同的 `annotation_id`，每个通道仍保留并导出自身原始起止时间；逻辑事件的总体边界仅用于界面管理。相同通道的两行不会互相合并。A、REM、SEM、MBM 按输入行直接视为 event-level，不应用该聚类规则。

- `annotation_id` 始终标识一个逻辑事件。
- K/S 是 channel-level：多通道行共享同一 `annotation_id`。
- A 手工标注默认为 `GLOBAL`；Detection 导入也允许六个标准 EEG 通道。
- REM/SEM 是 event-level，通道固定为 `LOC;ROC`。
- MBM 是 event-level，通道固定为 `GLOBAL`。
- `image_name` 是 recording 标识，必须等于 manifest 的 `recordingName`，不是 PNG 文件名。
- 导入允许 offset 超出单个 epoch 范围，并按 `epoch * epoch_length_sec + offset` 自动规范化；`duration_s` 必须等于起止时间差。

跨 epoch 事件在 `state.events` 中仍是一个事件，界面投影到多张图片。CSV 导出会沿 epoch 边界拆成多行；边界片段可使用 `end_offset = epoch_length_sec`，所有片段保持相同 `annotation_id`，因此重新导入后仍恢复为同一个逻辑事件。

manifest 顶层提供 `datasetName`、`recordingName`、`epochLengthSec`、`epochBase`、`canvas`、`channels` 和 `images`。每个通道提供 `name`、`topPct`、`bottomPct`。图片宽度固定，总高度随通道数增长。

旧项目的 `images_dir` 可兼容读取，但页面不再提供 EDF 读取、底图生成、任务恢复或生成缓存管理。

## 测试

```powershell
node test-import.js
python -m unittest -v test_workflow.py
```
