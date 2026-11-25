import os
import zipfile


def make_extension_zip():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    ext_dir = os.path.join(base_dir, "extension")
    zip_path = os.path.join(base_dir, "instant-theme-changer.zip")

    included_files = []
    for root, dirs, files in os.walk(ext_dir):
        # Skip runtime user-saved subfolders or browser cache files inside extension/themes
        rel_root = os.path.relpath(root, ext_dir).replace("\\", "/")
        if rel_root.startswith("themes/wallpapers") or rel_root.startswith("themes/themes"):
            continue
        dirs[:] = [d for d in dirs if not (rel_root == "themes" and d in ("wallpapers", "themes"))]
        for name in sorted(files):
            if name == "Cached Theme.pak" or (rel_root == "themes" and name in ("manifest.json", "theme-studio-settings.json")):
                continue
            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, ext_dir).replace("\\", "/")
            included_files.append((full_path, rel_path))

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipf:
        for full_path, rel_path in included_files:
            zipf.write(full_path, arcname=rel_path)

    zip_size = os.path.getsize(zip_path)
    print(f"Created {zip_path} ({len(included_files)} files, {zip_size / 1024:.1f} KB)")


if __name__ == "__main__":
    make_extension_zip()
