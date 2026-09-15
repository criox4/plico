# Adds an app extension target (share extension, widget) to ios/App/App.xcodeproj and embeds it in the app.
# Idempotent. Usage: ruby scripts/ios-extension.rb <TargetName> <bundle-suffix> [framework ...]
# Needed because Xcode isn't available where this is scripted; open the project in Xcode afterwards to set the team.
require 'xcodeproj'

name, suffix, *frameworks = ARGV
abort 'usage: ios-extension.rb <TargetName> <bundle-suffix> [framework ...]' unless name && suffix
path = File.expand_path('../ios/App/App.xcodeproj', __dir__)
project = Xcodeproj::Project.open(path)
app = project.targets.find { |t| t.name == 'App' }

# The app itself gets the App Group entitlement once.
app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements' }
project.main_group['App'].new_file('App.entitlements') unless project.main_group['App'].files.any? { |f| f.path == 'App.entitlements' }

if project.targets.any? { |t| t.name == name }
  puts "#{name} already exists"
else
  target = project.new_target(:app_extension, name, :ios, '15.0')
  group = project.main_group.new_group(name, name)
  sources = Dir[File.expand_path("../ios/App/#{name}/*.swift", __dir__)].sort.map { |f| group.new_file(File.basename(f)) }
  target.add_file_references(sources)
  %w[Info.plist].concat(Dir[File.expand_path("../ios/App/#{name}/*.entitlements", __dir__)].map { |f| File.basename(f) }).each { |f| group.new_file(f) }
  frameworks.each { |fw| target.add_system_framework(fw) }
  target.build_configurations.each do |c|
    s = c.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = "app.plico.#{suffix}"
    s['INFOPLIST_FILE'] = "#{name}/Info.plist"
    s['CODE_SIGN_ENTITLEMENTS'] = "#{name}/#{name}.entitlements"
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['MARKETING_VERSION'] = '1.0'
    s['CURRENT_PROJECT_VERSION'] = '1'
    s['SKIP_INSTALL'] = 'YES'
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  end
  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
          app.new_copy_files_build_phase('Embed Foundation Extensions').tap { |p| p.dst_subfolder_spec = '13' }
  embed.add_file_reference(target.product_reference, true).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  app.add_dependency(target)
  puts "added #{name}"
end
project.save
