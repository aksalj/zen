import os
import sys
import subprocess
from pathlib import Path


def main():
  project_root = Path(__file__).resolve().parent
  package_json = project_root / 'package.json'

  # Ensure script is run from project root
  if not package_json.exists():
    print("Please run this script from the root of the project", file=sys.stderr)
    sys.exit(1)

  args = sys.argv[1:]
  if not args:
    path = ""
  else:
    path = args[0]

  # Collect any additional arguments
  other_args = [arg for arg in args if arg != path]

  engine_dir = project_root / 'engine'
  os.chdir(engine_dir)

  def run_mach_with_paths(test_paths):
    command = ['./mach', 'mochitest'] + other_args + test_paths
    subprocess.run(command, check=True)

  if path in ("", "all"):
    test_dirs = [p for p in Path("zen/tests").iterdir() if p.is_dir()]
    test_paths = [str(p) for p in test_dirs]
    run_mach_with_paths(test_paths)
  else:
    run_mach_with_paths([f"zen/tests/{path}"])

  # Return to original directory
  os.chdir(project_root)


if __name__ == "__main__":
  main()
