楽譜スクロール（オフライン対応Webアプリ）

このフォルダの中身を GitHub Pages などに置くと、iPad の Safari で開いて
「ホーム画面に追加」できます。一度開けば、あとはネットがなくても動きます。

楽譜のデータは iPad の中だけに保存され、どこにも送信されません。

ファイル構成
- index.html / app.js … アプリ本体
- sw.js … オフラインで動かすための仕組み（更新時は中の VERSION を変更）
- manifest.webmanifest / icons … ホーム画面用アイコン
- PDF表示には pdf.js（Mozilla, Apache License 2.0）を jsDelivr から読み込み、初回に端末へ保存します
