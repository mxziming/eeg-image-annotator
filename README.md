# EEG 图片标注器原型

本地 EEG 标注工作流：选择 EDF → 后台生成无标注底图 → 自动加载时间映射 → 导入检测 CSV → 校准通道 → 标注与保存。`wave_image_export.py` 已移动到本目录，生成器不依赖 Detection 项目、不调用 detector。

```powershell
cd "C:\Users\zhou\Documents\Sleep Model Research\eeg-image-annotator"
python server.py
```

然后打开：

```text
http://localhost:8765
```

## 推荐：项目工作流

1. 点击顶部 **项目 → 创建项目**，选择 **EDF文件目录** 和 **项目保存目录**。选择文件夹按钮会优先打开系统文件夹选择窗口；也可以直接输入尚未创建的项目路径。
2. 点击 **创建项目**。自动建立 `project.json`、images、annotations、cache、logs。输入目录只读，禁止与输出目录重叠；高级目录可填项目相对路径或外部绝对路径（创建时生效）。
3. 点击 **文件 → 生成无标注底图**，设置实际通道顺序、数据集名、记录标识、epoch 时基、显示低频/高频、默认每通道纵向显示范围（±μV）和 DPI。记录标识须与 detection CSV 的 image_name 一致。默认纵向范围为 ±100 μV；如果某个 epoch 内的实际最大/最小值超出该范围，该 epoch 会自动扩展纵轴上下限以完整显示波形。
4. 点击 **生成新版本并加载**。子进程读取 EDF，界面显示进度，可取消。完成后自动加载 PNG 和 manifest，不需要手动导入 JSON。支持 SouthData `[NNN].edf` 分块或单个 EDF；多份无明确编号的 EDF 会拒绝自动拼接。
5. 如需切换已有底图版本，点击 **文件 → 加载无标注底图**。这里只加载项目中已生成的底图版本；detection 输出请继续走 CSV 导入。
6. 点击 **加载 → 加载CSV标注** 导入 detection 长表或宽表；通道名称/数量从 manifest 初始化，仍需用户确认图上左右及各通道上下边界。manifest 窗口起点和长度不可在标注界面改写；改变它们请生成新版本。
7. 标注自动保存到对应版本的 `working.json`，保存上一份完整文件为 `working.previous.json`。点击 **保存 → 保存当前进度** 会等待后台落盘。点击 **保存 → 导出CSV标注** 会导出到版本内的 `exports/annotations.csv`，也保留上一份导出。
8. 重新打开项目时使用 **项目 → 打开项目**，可恢复该版本的图片、布局和标注。每次生成新版本均从未校准、无标注状态开始，不擅自迁移旧标注。

```text
project/
  project.json
  images/generation_<id>/
    generation_config.json
    images_manifest.json
    *.png
  annotations/generation_<id>/
    working.json
    working.previous.json
    exports/annotations.csv
  cache/                 # NumPy/MNE-related library configuration and plotting/JIT caches
  logs/                  # Worker progress JSON and error logs
```

再次启动时可直接指定项目：

```powershell
python server.py --project "E:\AnnotationProjects\recording_39\project.json" --port 8765
```

无 `--project` 时不会自动打开最近项目，可在界面选择。尚未打开项目时保留原环境变量模式：`EEG_IMAGE_DIR`、`EEG_CSV_PATH`、`EEG_DATASET_NAME`，默认仍为原 E 盘目录。打开项目后保存路径由项目接管，不再写入旧默认 CSV。配置修改不会自动搬移文件；已有输出目录需由用户先迁移并更新 project.json，再重新打开。建议一个服务实例只用一个页面编辑同一版本，不支持多用户并发合并。

绘图参数跟随每个版本保存在 generation_config.json，打开该版本的项目面板时自动回填。失败/取消任务保留日志及已生成的部分文件，不将其自动加载；只有完整 manifest 的版本可激活。重启服务后可加载已完成版本，但不会恢复中断任务。没有自动清理文件的操作，cache 可重新生成，manifest/config/annotations 不是缓存。

依赖见 requirements.txt（`python -m pip install -r requirements.txt`）。服务仅监听 127.0.0.1，写入 API 带本机会话令牌；不要作为公开网络服务部署。

验证命令：

```powershell
node test-import.js
python -B -m unittest test_workflow -v
```

也可保留独立命令行绘图用法：

```powershell
python wave_image_export.py --edf-folder "E:\Dataset\SouthData\recording_39" --output-dir "E:\WaveImages\recording_39" --channels F3M2 F4M1 C3M2 C4M1
```

## 当前规则

- 默认通道顺序：`EEG F3-CLE`、`EEG F4-CLE`、`EEG C3-CLE`、`EEG C4-CLE`
- 每个标注框代表一个事件
- 框与某个通道区域的重叠高度大于该通道高度的 `50%` 时，该通道会导出一行
- 跨多个通道时导出多行；只覆盖单通道时导出单行
- 时间换算使用当前图片的 `窗口起点` 和 `窗口长度`

## 输出 CSV 字段

新增 detection 对接流程：先通过 **文件 → 生成无标注底图** 或 **文件 → 加载无标注底图** 载入底图版本，然后通过 **加载 → 加载CSV标注** 导入 `Detected_K/S/A.csv` 或 `Detected_K/S/A_wide.csv`。宽表通道值为 `1`（检出）、`0`（输入存在但未检出）、`NA`（输入不存在）。

在“布局校准”中设置实际通道名称和顺序，点选左右及各通道上下边界，点击“确认校准并显示标注框”。导入数据保存窗口内的相对时间；调整校准不会改变事件时间。缺少布局的通道保留为待配置数据。K波、纺锤波、微觉醒均可选择。

同一事件按通道和窗口分段显示，各片段独立编辑并共享事件 ID。导出仍是图片名格式的 CSV；跨窗口片段不会自动拼接。旧的像素坐标 JSON 仍可读取。底图生成说明见 Detection 目录的 `ANNOTATOR_WORKFLOW.md`。

```csv
type,start_epoch,start_offset,end_epoch,end_offset,channel,dataset_name,image_name,duration_s,annotation_id
```

## 保存方式

- 项目生成图片模式会将进度写入项目目录。
- **保存 → 保存当前进度** 用于立即等待当前版本的 `working.json` 落盘。
- **保存 → 导出CSV标注** 用于保存当前标注结果。
- **加载 → 加载CSV标注** 会将 detection CSV 转换为当前底图上的参考框，可在图片上编辑、删除，并随本轮标注一起导出。

## 使用建议

第一次使用时，用一张标准 EEG 图片检查右侧“布局校准”。如果四个浅绿色通道区域和波形 panel 对齐，就可以批量标注；如果有偏移，调整百分比后再继续。
