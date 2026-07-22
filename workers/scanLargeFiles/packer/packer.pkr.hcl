packer {
  required_plugins {
    amazon = {
      version = ">= 1.8.2"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "build_instance_type" {
  type        = string
  default     = "t3.medium"
  description = "Instance type used to build the AMI"
}

source "amazon-ebs" "temp-scanner-base" {
  region        = var.aws_region
  instance_type = var.build_instance_type

  // what base AMI to use for the build
  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["amazon"]
  }

  ami_name        = "large-file-scanner-{{timestamp}}"
  ami_description = "ClamAV large file scanner for Temp"
  ami_regions     = [var.aws_region] // regions to copy the AMI to

  ssh_username = "ec2-user"

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  tags = {
    Name      = "large-file-scanner"
    Project   = "temp"
    ManagedBy = "packer"
  }
}

build {
  name    = "large-file-scanner"
  sources = ["source.amazon-ebs.temp-scanner-base"] // specifies which source builder to use for the build

  // Create destination directory before uploading files
  provisioner "shell" {
    inline = ["mkdir -p /tmp/scanner-app"]
  }

  // copies files into the ec2 instance
  provisioner "file" {
    sources = [
      "../app/index.ts",
      "../app/package*.json",
      "../app/tsconfig.json",
    ]
    destination = "/tmp/scanner-app/"
  }

  provisioner "file" {
    source      = "scanner.service"
    destination = "/tmp/scanner.service"
  }

  // run the shell script inside the ec2
  provisioner "shell" {
    script = "setup.sh"
  }
}
